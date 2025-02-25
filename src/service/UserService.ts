import mongoose, { InferSchemaType, PipelineStage, ClientSession } from 'mongoose'
import { createCloudflareImageUploadSignedUrl } from '../cloudflare/index.js'
import { isInvalidEmail, sendMail } from '../common/EmailTool.js'
import { comparePasswordSync, hashPasswordSync } from '../common/HashTool.js'
import { isEmptyObject } from '../common/ObjectTool.js'
import { generateRandomString, generateSecureRandomString, generateSecureVerificationNumberCode, generateSecureVerificationStringCode } from '../common/RandomTool.js'
import {
	AdminClearUserInfoRequestDto,
	AdminClearUserInfoResponseDto,
	AdminGetUserInfoRequestDto,
	AdminGetUserInfoResponseDto,
	ApproveUserInfoRequestDto,
	ApproveUserInfoResponseDto,
	BlockUserByUIDRequestDto,
	BlockUserByUIDResponseDto,
	CheckInvitationCodeRequestDto,
	CheckInvitationCodeResponseDto,
	CheckUsernameRequestDto,
	CheckUsernameResponseDto,
	CheckUserTokenResponseDto,
	CreateInvitationCodeResponseDto,
	DeleteTotpAuthenticatorByTotpVerificationCodeResponseDto,
	GetBlockedUserResponseDto,
	GetMyInvitationCodeResponseDto,
	GetSelfUserInfoRequestDto,
	GetSelfUserInfoResponseDto,
	CheckUserHave2FAResponseDto,
	GetUserAvatarUploadSignedUrlResponseDto,
	GetUserInfoByUidRequestDto,
	GetUserInfoByUidResponseDto,
	GetUserInvitationCodeResponseDto,
	GetUserSettingsResponseDto,
	ReactivateUserByUIDRequestDto,
	ReactivateUserByUIDResponseDto,
	RequestSendChangeEmailVerificationCodeRequestDto,
	RequestSendChangeEmailVerificationCodeResponseDto,
	RequestSendChangePasswordVerificationCodeRequestDto,
	RequestSendChangePasswordVerificationCodeResponseDto,
	RequestSendVerificationCodeRequestDto,
	RequestSendVerificationCodeResponseDto,
	UpdateOrCreateUserInfoRequestDto,
	UpdateOrCreateUserInfoResponseDto,
	UpdateOrCreateUserSettingsRequestDto,
	UpdateOrCreateUserSettingsResponseDto,
	UpdateUserEmailRequestDto,
	UpdateUserEmailResponseDto,
	UpdateUserPasswordRequestDto,
	UpdateUserPasswordResponseDto,
	UseInvitationCodeDto,
	UseInvitationCodeResultDto,
	UserLoginRequestDto,
	UserLoginResponseDto,
	UserRegistrationRequestDto,
	UserRegistrationResponseDto,
	GetSelfUserInfoByUuidResponseDto,
	GetSelfUserInfoByUuidRequestDto,
	CreateUserTotpAuthenticatorResponseDto,
	DeleteTotpAuthenticatorByTotpVerificationCodeRequestDto,
	ConfirmUserTotpAuthenticatorRequestDto,
	ConfirmUserTotpAuthenticatorResponseDto,
	CheckUserHave2FARequestDto,
	CreateUserEmailAuthenticatorResponseDto,
	SendUserEmailAuthenticatorVerificationCodeRequestDto,
	SendUserEmailAuthenticatorVerificationCodeResponseDto,
	CheckEmailAuthenticatorVerificationCodeRequestDto,
	CheckEmailAuthenticatorVerificationCodeResponseDto,
	DeleteUserEmailAuthenticatorRequestDto,
	DeleteUserEmailAuthenticatorResponseDto,
	SendDeleteUserEmailAuthenticatorVerificationCodeRequestDto,
	SendDeleteUserEmailAuthenticatorVerificationCodeResponseDto,
	UserExistsCheckByUIDRequestDto,
	UserExistsCheckByUIDResponseDto,
	UserEmailExistsCheckRequestDto,
	UserEmailExistsCheckResponseDto,
} from '../controller/UserControllerDto.js'
import { findOneAndUpdateData4MongoDB, insertData2MongoDB, selectDataFromMongoDB, updateData4MongoDB, selectDataByAggregateFromMongoDB, deleteDataFromMongoDB } from '../dbPool/DbClusterPool.js'
import { DbPoolResultsType, QueryType, SelectType, UpdateType } from '../dbPool/DbClusterPoolTypes.js'
import { UserAuthSchema, UserTotpAuthenticatorSchema, UserChangeEmailVerificationCodeSchema, UserChangePasswordVerificationCodeSchema, UserInfoSchema, UserInvitationCodeSchema, UserSettingsSchema, UserVerificationCodeSchema, UserEmailAuthenticatorSchema, UserEmailAuthenticatorVerificationCodeSchema } from '../dbPool/schema/UserSchema.js'
import { getNextSequenceValueService } from './SequenceValueService.js'
import { authenticator } from 'otplib'
import { abortAndEndSession, commitSession, createAndStartSession } from '../common/MongoDBSessionTool.js'
import { StorageClassAnalysisSchemaVersion } from '@aws-sdk/client-s3'

authenticator.options = { window: 1 } // 设置 TOTP 宽裕一个窗口

/**
 * 用户注册
 * @param userRegistrationRequest 用户注册时需要传入的信息（用户名，密码）
 * @returns UserRegistrationResponseDto 用户注册的结果，如果成功会包含 token
 */
export const userRegistrationService = async (userRegistrationRequest: UserRegistrationRequestDto): Promise<UserRegistrationResponseDto> => {
	try {
		if (checkUserRegistrationData(userRegistrationRequest)) {
			if (!(await checkInvitationCodeService({ invitationCode: userRegistrationRequest.invitationCode })).isAvailableInvitationCode) { // DELETEME 仅在 beta 测试中使用
				console.error('ERROR', '用户注册失败：邀请码无效')
				return { success: false, message: '用户注册失败：邀请码无效' }
			}
			const { email, passwordHash, passwordHint, verificationCode, username, userNickname } = userRegistrationRequest
			const emailLowerCase = email.toLowerCase()

			if (email && emailLowerCase && verificationCode) {
				// 启动事务
				const session = await mongoose.startSession()
				session.startTransaction()

				const now = new Date().getTime()
				const { collectionName, schemaInstance } = UserAuthSchema
				type UserAuth = InferSchemaType<typeof schemaInstance>

				const userAuthWhere: QueryType<UserAuth> = {
					emailLowerCase,
					username: { $regex: new RegExp(`\\b${username}\\b`, 'iu') },
				}
				const userAuthSelect: SelectType<UserAuth> = { emailLowerCase: 1 }
				try {
					const useAuthResult = await selectDataFromMongoDB<UserAuth>(userAuthWhere, userAuthSelect, schemaInstance, collectionName, { session })
					if (useAuthResult.result && useAuthResult.result.length >= 1) {
						if (session.inTransaction()) {
							await session.abortTransaction()
						}
						session.endSession()
						console.error('ERROR', '用户注册失败：用户邮箱重复：', { email, emailLowerCase })
						return { success: false, message: '用户注册失败：用户邮箱重复' }
					}
				} catch (error) {
					if (session.inTransaction()) {
						await session.abortTransaction()
					}
					session.endSession()
					console.error('ERROR', '用户注册失败：用户邮箱查重时出现异常：', error, { email, emailLowerCase })
					return { success: false, message: '用户注册失败：用户邮箱查重时出现异常' }
				}

				const { collectionName: userVerificationCodeCollectionName, schemaInstance: userVerificationCodeSchemaInstance } = UserVerificationCodeSchema
				type UserVerificationCode = InferSchemaType<typeof userVerificationCodeSchemaInstance>
				const verificationCodeWhere: QueryType<UserVerificationCode> = {
					emailLowerCase,
					verificationCode,
					overtimeAt: { $gte: now },
				}

				const verificationCodeSelect: SelectType<UserVerificationCode> = {
					emailLowerCase: 1, // 用户邮箱
				}

				try {
					const verificationCodeResult = await selectDataFromMongoDB<UserVerificationCode>(verificationCodeWhere, verificationCodeSelect, userVerificationCodeSchemaInstance, userVerificationCodeCollectionName, { session })
					if (!verificationCodeResult.success || verificationCodeResult.result?.length !== 1) {
						if (session.inTransaction()) {
							await session.abortTransaction()
						}
						session.endSession()
						console.error('ERROR', '用户注册失败：验证失败')
						return { success: false, message: '用户注册失败：验证失败' }
					}
				} catch (error) {
					if (session.inTransaction()) {
						await session.abortTransaction()
					}
					session.endSession()
					console.error('ERROR', '用户注册失败：请求验证失败')
					return { success: false, message: '用户注册失败：请求验证失败' }
				}

				const passwordHashHash = hashPasswordSync(passwordHash)
				const token = generateSecureRandomString(64)
				const uid = (await getNextSequenceValueService('user', 1, 1, session)).sequenceValue
				const uuid = generateRandomString(24)

				const userAuthData: UserAuth = {
					UUID: uuid,
					uid,
					email,
					emailLowerCase,
					passwordHashHash,
					token,
					passwordHint,
					role: 'user', // newbie will always be user role.
					authenticatorType: 'none', // 刚注册的用户默认没有开启 2FA
					userCreateDateTime: now,
					editDateTime: now,
				}

				const { collectionName: userInfoCollectionName, schemaInstance: userInfoSchemaInstance } = UserInfoSchema
				type UserInfo = InferSchemaType<typeof userInfoSchemaInstance>
				const userInfoData: UserInfo = {
					UUID: uuid,
					uid,
					username,
					userNickname,
					label: [] as UserInfo['label'], // TODO: Mongoose issue: #12420
					userLinkAccounts: [] as UserInfo['userLinkAccounts'], // TODO: Mongoose issue: #12420
					isUpdatedAfterReview: true,
					editDateTime: now,
					createDateTime: now,
				}


				const { collectionName: userSettingsCollectionName, schemaInstance: userSettingsSchemaInstance } = UserSettingsSchema
				type UserSettings = InferSchemaType<typeof userSettingsSchemaInstance>
				const userSettingsData: UserSettings = {
					UUID: uuid,
					uid,
					userLinkAccountsPrivacySetting: [] as UserSettings['userLinkAccountsPrivacySetting'], // TODO: Mongoose issue: #12420
					editDateTime: now,
					createDateTime: now,
				}

				try {
					const saveUserAuthResult = await insertData2MongoDB(userAuthData, schemaInstance, collectionName, { session })
					const saveUserInfoResult = await insertData2MongoDB(userInfoData, userInfoSchemaInstance, userInfoCollectionName, { session })
					const saveUserSettingsResult = await insertData2MongoDB(userSettingsData, userSettingsSchemaInstance, userSettingsCollectionName, { session })
					if (saveUserAuthResult.success && saveUserInfoResult.success && saveUserSettingsResult.success) {
						const invitationCode = userRegistrationRequest.invitationCode
						if (invitationCode) {
							const useInvitationCodeDto: UseInvitationCodeDto = {
								invitationCode,
								registrantUid: uid,
								registrantUUID: uuid,
							}
							try {
								const useInvitationCodeResult = await useInvitationCode(useInvitationCodeDto)
								if (!useInvitationCodeResult.success) {
									console.error('ERROR', '用户使用邀请码时出错：更新邀请码使用者失败')
								}
							} catch (error) {
								console.error('ERROR', '用户使用邀请码时出错：更新邀请码使用者时出错：', error)
							}
						}
						await session.commitTransaction()
						session.endSession()
						return { success: true, uid, token, UUID: uuid, message: '用户注册成功' }
					} else {
						if (session.inTransaction()) {
							await session.abortTransaction()
						}
						session.endSession()
						console.error('ERROR', '用户注册失败：向 MongoDB 插入数据失败：')
						return { success: false, message: '用户注册失败：保存数据失败' }
					}
				} catch (error) {
					if (session.inTransaction()) {
						await session.abortTransaction()
					}
					session.endSession()
					console.error('ERROR', '用户注册失败：向 MongoDB 插入数据时出现异常：', error)
					return { success: false, message: '用户注册失败：无法保存用户资料' }
				}
			} else {
				console.error('ERROR', '用户注册失败：email 或 emailLowerCase 或 verificationCode 可能为空')
				return { success: false, message: '用户注册失败：生成账户资料时失败' }
			}
		} else {
			console.error('ERROR', '用户注册失败：userRegistrationData 的非空验证没有通过')
			return { success: false, message: '用户注册失败：非空验证没有通过' }
		}
	} catch (error) {
		console.error('userRegistrationService 函数中出现异常', error)
		return { success: false, message: '用户注册失败：程序异常终止' }
	}
}

/**
 * 用户登录
 * @param userLoginRequest 用户登录时需要传入的信息（用户名，密码）
 * @return UserLoginResponseDto 用户登录结果，如果登录成功会包含 token
 */
export const userLoginService = async (userLoginRequest: UserLoginRequestDto): Promise<UserLoginResponseDto> => {
	try {
		// 1. 检查请求参数是否合法
		if (!checkUserLoginRequest(userLoginRequest)) {
			console.error('ERROR', '用户登录时程序异常：用户信息校验未通过')
			return { success: false, message: '用户信息校验未通过' }
		}

		const { email, passwordHash, clientOtp } = userLoginRequest
		const emailLowerCase = email.toLowerCase()
		const { collectionName, schemaInstance } = UserAuthSchema
		type UserAuth = InferSchemaType<typeof schemaInstance>

		const userLoginWhere: QueryType<UserAuth> = { emailLowerCase }
		const userLoginSelect: SelectType<UserAuth> = {
			email: 1,
			UUID: 1,
			uid: 1,
			token: 1,
			passwordHint: 1,
			passwordHashHash: 1,
			authenticatorType: 1,
		}

		// 2. 获取用户安全信息
		const userAuthResult = await selectDataFromMongoDB<UserAuth>(userLoginWhere, userLoginSelect, schemaInstance, collectionName)
		if (!userAuthResult?.result || userAuthResult.result?.length !== 1) {
			console.error('ERROR', `用户登录（查询用户信息）时出现异常，用户邮箱：【${email}】，用户未注册或信息异常`)
			return { success: false, email, message: '用户未注册或信息异常' }
		}

		const userAuthData = userAuthResult.result[0]
		const { token, uid, UUID: uuid, authenticatorType } = userAuthData
		if (!token || uid === null || uid === undefined || !uuid) {
			console.error('ERROR', `登录失败，未能获取用户安全信息`)
			return { success: false, message: '登录失败，未能获取用户安全信息' }
		}

		// 3. 检查用户密码是否正确
		const isCorrectPassword = comparePasswordSync(passwordHash, userAuthData.passwordHashHash)
		if (!isCorrectPassword) {
			return { success: false, email, passwordHint: userAuthData.passwordHint, message: '用户密码错误' }
		}

		// 4. 判断用户是否启用了 2FA
		if (authenticatorType === 'totp') { // 4.1 TOTP
			const maxAttempts	 = 5 // 最大尝试次数
			const lockTime = 60 * 60 * 1000 // 冷却时间
			const now = new Date().getTime()

			if (!clientOtp) {
				console.error('登录失败，启用了 TOTP 但用户未提供验证码', authenticatorType )
				return { success: false, message:"登录失败，启用了 TOTP 但用户未提供验证码", authenticatorType }
			}

			const { collectionName: userTotpAuthenticatorCollectionName, schemaInstance: userTotpAuthenticatorSchemaInstance } = UserTotpAuthenticatorSchema
			type UserAuthenticator = InferSchemaType<typeof userTotpAuthenticatorSchemaInstance>
			const userTotpAuthenticatorWhere: QueryType<UserAuthenticator> = {
				UUID: uuid,
				enabled: true,
			}

			if (clientOtp.length > 6) { // 大于六位时，视为使用 TOTP 恢复码进行登录（登录成功后会删除 TOTP 2FA）
				const userTotpAuthenticatorSelect: SelectType<UserAuthenticator> = {
					recoveryCodeHash: 1,
				}

				const selectResult = await selectDataFromMongoDB<UserAuthenticator>(userTotpAuthenticatorWhere, userTotpAuthenticatorSelect, userTotpAuthenticatorSchemaInstance, userTotpAuthenticatorCollectionName)

				if (!selectResult.success || selectResult.result.length !== 1) {
					console.error('ERROR', '登录失败，获取验证数据失败 - 1')
					return { success: false, message: '登录失败，获取验证数据失败 - 1', authenticatorType }
				}

				const recoveryCodeHash = selectResult.result[0].recoveryCodeHash
				const isCorrectRecoveryCode = comparePasswordSync(clientOtp, recoveryCodeHash)

				if (!isCorrectRecoveryCode) {
					console.error('ERROR', '登录失败，恢复码错误')
					return { success: false, message: '登录失败，恢复码错误', authenticatorType }
				}

				const session = await mongoose.startSession()
				session.startTransaction()

				const deleteTotpAuthenticatorByRecoveryCodeData: DeleteTotpAuthenticatorByRecoveryCodeParametersDto = {
					email,
					recoveryCodeHash,
					session
				}
				const deleteResult = await deleteTotpAuthenticatorByRecoveryCode(deleteTotpAuthenticatorByRecoveryCodeData) // 如果使用恢复码登陆成功，则删除 TOTP 2FA

				if (!deleteResult.success) {
					if (session.inTransaction()) {
						await session.abortTransaction()
					}
					session.endSession()
					console.error('ERROR', '登录失败，未能删除 TOTP 2FA')
					return { success: false, message: '登录失败，未能删除 TOTP 2FA', authenticatorType }
				}

				await session.commitTransaction()
				session.endSession()
				return { success: true, email, uid, token, UUID: uuid, message: '使用恢复码登录成功，你的 TOTP 2FA 已删除', authenticatorType }
			} else { // 不大于六位数时，视为使用 TOTP 验证码或 TOTP 备份码进行登录，先视为 TOTP 验证码尝试，如果验证失败，则视为 TOTP 备份码尝试，如果都失败，则响应登陆失败
				const userTotpAuthenticatorSelect: SelectType<UserAuthenticator> = {
					secret: 1,
					backupCodeHash: 1,
					lastAttemptTime: 1,
					attempts: 1,
				}

				const selectResult = await selectDataFromMongoDB<UserAuthenticator>(userTotpAuthenticatorWhere, userTotpAuthenticatorSelect, userTotpAuthenticatorSchemaInstance, userTotpAuthenticatorCollectionName)

				if (!selectResult.success || selectResult.result.length !== 1) {
					console.error('ERROR', '登录失败，获取验证数据失败 - 2')
					return { success: false, message: '登录失败，获取验证数据失败 - 2', authenticatorType }
				}

				let attempts = selectResult.result[0].attempts

				const totpSecret = selectResult.result[0].secret
				const listOfBackupCodeHash = selectResult.result[0].backupCodeHash

				// 限制用户的登录频率
				if (selectResult.result[0].attempts >= maxAttempts) {
					const lastAttemptTime = new Date(selectResult.result[0].lastAttemptTime).getTime();
					if (now - lastAttemptTime < lockTime) {
						attempts += 1
						console.warn('WARN', 'WARNING', '用户登录失败，已达最大尝试次数，请稍后再试');
						return { success: false, message: '登录失败，已达最大尝试次数，请稍后再试', isCoolingDown: true, authenticatorType };
					} else {
						attempts = 0
					}

					//启动事务
					const session = await mongoose.startSession()
					session.startTransaction()

					const userLoginByBackupCodeUpdate: UpdateType<UserAuthenticator> = {
						attempts: attempts,
						lastAttemptTime: now,
					}
					const updateAuthenticatorResult = await findOneAndUpdateData4MongoDB<UserAuthenticator>(userTotpAuthenticatorWhere, userLoginByBackupCodeUpdate, userTotpAuthenticatorSchemaInstance, userTotpAuthenticatorCollectionName, { session })

					if (!updateAuthenticatorResult.success) {
						if (session.inTransaction()) {
							await session.abortTransaction()
						}
						session.endSession()
						console.error('ERROR', '登录失败，更新最后尝试时间或尝试次数失败')
						return { success: false, message: '登录失败，更新最后尝试时间或尝试次数失败', isCoolingDown: true, authenticatorType }
					}
				}

				if (!authenticator.check(clientOtp, totpSecret)) {
					attempts += 1
					let useCorrectBackupCode = false // 用户是否使用了一个正确的备用码。
					const newBackupCodeHash = []
					listOfBackupCodeHash.forEach( backupCodeHash => {
						const isCorrectBackupCode = comparePasswordSync(clientOtp, backupCodeHash)
						if (isCorrectBackupCode) {
							useCorrectBackupCode = true
						} else {
							newBackupCodeHash.push(backupCodeHash)
						}
					})

					if (!useCorrectBackupCode) {
						console.error('ERROR', '登录失败，验证码或备份码不正确');
						return { success: false, message: '登录失败，验证码或备份码不正确', authenticatorType };
					}
					const session = await mongoose.startSession()
					session.startTransaction()

					const userLoginByBackupCodeUpdate: UpdateType<UserAuthenticator> = {
						backupCodeHash: newBackupCodeHash,
						editDateTime: now,
						attempts,
						lastAttemptTime: now,
					}

					// 使用备份码登录后，将除了已使用的备份码之外的备份码写回数据库（这样一来，备份码就无法被重复使用了）
					const updateAuthenticatorResult = await findOneAndUpdateData4MongoDB<UserAuthenticator>(userTotpAuthenticatorWhere, userLoginByBackupCodeUpdate, userTotpAuthenticatorSchemaInstance, userTotpAuthenticatorCollectionName, { session })

					if (!updateAuthenticatorResult.success) {
						if (session.inTransaction()) {
							await session.abortTransaction()
						}
						session.endSession()
						console.error('ERROR', '登录失败，更新备份码失败')
						return { success: false, message: '登录失败，更新备份码失败', authenticatorType }
					}

					await commitSession(session)
					return { success: true, email, uid, token, UUID: uuid, message: '用户使用备用码登录成功', authenticatorType }
				} else {
					return { success: true, email, uid, token, UUID: uuid, message: '用户使用 TOTP 验证码登录成功', authenticatorType }
				}
			}
		} else if (authenticatorType === 'email') {
			const { verificationCode } = userLoginRequest
			if (!verificationCode) {
				console.error('ERROR', '登录失败，启用了邮箱验证但用户未提供验证码')
				return { success: false, message: '登录失败，启用了邮箱验证但用户未提供验证码', authenticatorType }
			}

			if (verificationCode.length !== 6) {
				console.error('ERROR', '登录失败，验证码长度错误')
				return { success: false, message: '登录失败，验证码长度错误', authenticatorType }
			}

			const checkVerificationCodeData = {
				email: emailLowerCase,
				verificationCode: verificationCode
			}

			if (!(await checkEmailAuthenticatorVerificationCodeService(checkVerificationCodeData)).success) {
				console.error('ERROR', '登录失败，验证码错误')
				return { success: false, message: '登录失败，验证码错误', authenticatorType }
			}

			return { success: true, email, uid, token, UUID: uuid, message: '用户登录成功', authenticatorType }
		} else {
			return { success: true, email, uid, token, UUID: uuid, message: '用户登录成功', authenticatorType: 'none' }
		}
	} catch (error) {
		console.error('ERROR', '用户登录时程序异常：', error)
		return { success: false, message: '用户登录时程序异常' }
	}
}

/**
 * 检查一个用户邮箱是否存在
 * @param checkUserExistsCheckRequest 检查用户邮箱是否存在需要的信息（用户邮箱）
 * @return UserExistsCheckResponseDto 检查结果
 */
export const userEmailExistsCheckService = async (userEmailExistsCheckRequest: UserEmailExistsCheckRequestDto): Promise<UserEmailExistsCheckResponseDto> => {
	try {
		if (checkUserEmailExistsCheckRequest(userEmailExistsCheckRequest)) {
			const { collectionName, schemaInstance } = UserAuthSchema
			type UserAuth = InferSchemaType<typeof schemaInstance>
			const where: QueryType<UserAuth> = {
				emailLowerCase: userEmailExistsCheckRequest.email.toLowerCase(),
			}
			const select: SelectType<UserAuth> = {
				emailLowerCase: 1,
			}

			let result: DbPoolResultsType<UserAuth>
			try {
				result = await selectDataFromMongoDB(where, select, schemaInstance, collectionName)
			} catch (error) {
				console.error('ERROR', '验证用户是否存在（查询用户）时出现异常：', error)
				return { success: false, exists: false, message: '验证用户是否存在时出现异常' }
			}

			if (result && result.success && result.result) {
				if (result.result?.length > 0) {
					return { success: true, exists: true, message: '用户已存在' }
				} else {
					return { success: true, exists: false, message: '用户不存在' }
				}
			} else {
				return { success: false, exists: true, message: '查询失败' }
			}
		}
	} catch (error) {
		console.error('ERROR', '查询用户是否存在时出错：', error)
		return { success: false, exists: true, message: '验证用户是否存在时程序异常' }
	}
}

/**
 * 修改用户的 email
 * @param updateUserEmailRequest 修改用户的 email 的请求参数
 * @param uid 用户 ID
 * @param token 用户 token
 * @returns 修改用户的 email 的请求响应
 */
export const updateUserEmailService = async (updateUserEmailRequest: UpdateUserEmailRequestDto, cookieUid: number, cookieToken: string): Promise<UpdateUserEmailResponseDto> => {
	try {
		// TODO: 向旧邮箱发送邮件以验证
		if (await checkUserToken(cookieUid, cookieToken)) {
			if (checkUpdateUserEmailRequest(updateUserEmailRequest)) {
				const { uid, oldEmail, newEmail, passwordHash, verificationCode } = updateUserEmailRequest
				const now = new Date().getTime()

				if (cookieUid !== uid) {
					console.error('ERROR', '更新用户邮箱失败，cookie 中的 UID 与修改邮箱时使用的 UID 不同', { cookieUid, uid, oldEmail })
					return { success: false, message: '更新用户邮箱失败，未指定正确的用户' }
				}

				const oldEmailLowerCase = oldEmail.toLowerCase()
				const newEmailLowerCase = newEmail.toLowerCase()

				// 启动事务
				const session = await mongoose.startSession()
				session.startTransaction()

				const { collectionName, schemaInstance } = UserAuthSchema
				type UserAuth = InferSchemaType<typeof schemaInstance>

				const userAuthWhere: QueryType<UserAuth> = { uid, emailLowerCase: oldEmailLowerCase, cookieToken } // 使用 uid, emailLowerCase 和 token 确保用户更新的是自己的邮箱，而不是其他用户的
				const userAuthSelect: SelectType<UserAuth> = { passwordHashHash: 1, emailLowerCase: 1 }
				try {
					const userAuthResult = await selectDataFromMongoDB<UserAuth>(userAuthWhere, userAuthSelect, schemaInstance, collectionName, { session })
					const userAuthData = userAuthResult.result
					if (userAuthData) {
						if (userAuthData.length !== 1) { // 确保只更新一个用户的邮箱
							if (session.inTransaction()) {
								await session.abortTransaction()
							}
							session.endSession()
							console.error('ERROR', '更新用户邮箱失败，匹配到零个或多个用户', { uid, oldEmail })
							return { success: false, message: '更新用户邮箱失败，无法找到正确的用户' }
						}

						const isCorrectPassword = comparePasswordSync(passwordHash, userAuthData[0].passwordHashHash) // 确保更新邮箱时输入的密码正确
						if (!isCorrectPassword) {
							console.error('ERROR', '更新用户邮箱失败，用户密码不正确', { uid, oldEmail })
							if (session.inTransaction()) {
								await session.abortTransaction()
							}
							session.endSession()
							return { success: false, message: '更新用户邮箱失败，用户密码不正确' }
						}
					}
				} catch (error) {
					console.error('ERROR', '更新用户邮箱失败，校验用户密码时程序出现异常', error, { uid, oldEmail })
					if (session.inTransaction()) {
						await session.abortTransaction()
					}
					session.endSession()
					return { success: false, message: '用户注册失败：校验用户密码失败' }
				}

				try {
					const { collectionName: userChangeEmailVerificationCodeCollectionName, schemaInstance: userChangeEmailVerificationCodeSchemaInstance } = UserChangeEmailVerificationCodeSchema
					type UserChangeEmailVerificationCode = InferSchemaType<typeof userChangeEmailVerificationCodeSchemaInstance>
					const verificationCodeWhere: QueryType<UserChangeEmailVerificationCode> = {
						emailLowerCase: oldEmailLowerCase,
						verificationCode,
						overtimeAt: { $gte: now },
					}

					const verificationCodeSelect: SelectType<UserChangeEmailVerificationCode> = {
						emailLowerCase: 1, // 用户邮箱
					}

					const verificationCodeResult = await selectDataFromMongoDB<UserChangeEmailVerificationCode>(verificationCodeWhere, verificationCodeSelect, userChangeEmailVerificationCodeSchemaInstance, userChangeEmailVerificationCodeCollectionName, { session })
					if (!verificationCodeResult.success || verificationCodeResult.result?.length !== 1) {
						if (session.inTransaction()) {
							await session.abortTransaction()
						}
						session.endSession()
						console.error('ERROR', '修改邮箱失败：验证失败')
						return { success: false, message: '修改邮箱失败：验证失败' }
					}
				} catch (error) {
					if (session.inTransaction()) {
						await session.abortTransaction()
					}
					session.endSession()
					console.error('ERROR', '修改邮箱失败：请求验证失败')
					return { success: false, message: '修改邮箱失败：请求验证失败' }
				}

				const updateUserEmailWhere: QueryType<UserAuth> = {
					uid,
				}
				const updateUserEmailUpdate: QueryType<UserAuth> = {
					email: newEmail,
					emailLowerCase: newEmailLowerCase,
					editDateTime: new Date().getTime(),
				}
				try {
					const updateResult = await updateData4MongoDB(updateUserEmailWhere, updateUserEmailUpdate, schemaInstance, collectionName)
					if (updateResult && updateResult.success && updateResult.result) {
						if (updateResult.result.matchedCount > 0 && updateResult.result.modifiedCount > 0) {
							await session.commitTransaction()
							session.endSession()
							return { success: true, message: '用户邮箱更新成功' }
						} else {
							console.error('ERROR', '更新用户邮箱时，更新数量为 0', { uid, oldEmail, newEmail })
							if (session.inTransaction()) {
								await session.abortTransaction()
							}
							session.endSession()
							return { success: false, message: '用户邮箱更新失败，无法更新用户邮箱' }
						}
					} else {
						console.error('ERROR', '更新用户邮箱时，更新数量为 0', { uid, oldEmail, newEmail })
						if (session.inTransaction()) {
							await session.abortTransaction()
						}
						session.endSession()
						return { success: false, message: '用户邮箱更新失败，无法更新用户邮箱' }
					}
				} catch (error) {
					console.error('ERROR', '更新用户邮箱出错', { uid, oldEmail, newEmail }, error)
					if (session.inTransaction()) {
						await session.abortTransaction()
					}
					session.endSession()
					return { success: false, message: '用户邮箱更新失败，更新用户身份时出错' }
				}
			} else {
				console.error('ERROR', '更新用户邮箱时失败，未获取到原始数据')
				return { success: false, message: '用户邮箱更新失败，无法获取用户原始信息，数据可能为空' }
			}
		} else {
			console.error('ERROR', '更新用户邮箱时失败，用户不合法')
			return { success: false, message: '用户邮箱更新失败，用户不合法' }
		}
	} catch (error) {
		console.error('ERROR', '修改用户邮箱失败，未知错误：', error)
		return { success: false, message: '修改用户邮箱失败，未知错误' }
	}
}

/**
 * 根据 UID 更新或创建用户信息
 * @param updateUserInfoRequest 更新或创建用户信息时的请求参数
 * @param uid 用户 ID
 * @param token 用户 token
 * @returns 更新或创建用户信息的请求结果
 */
export const updateOrCreateUserInfoService = async (updateOrCreateUserInfoRequest: UpdateOrCreateUserInfoRequestDto, uid: number, token: string): Promise<UpdateOrCreateUserInfoResponseDto> => {
	try {
		if (await checkUserRoleService(uid, 'blocked')) {
			console.error('ERROR', '更新或创建用户信息失败，用户已封禁')
			return { success: false, message: '更新或创建用户信息失败，用户已封禁' }
		}

		if (await checkUserToken(uid, token)) {
			if (checkUpdateOrCreateUserInfoRequest(updateOrCreateUserInfoRequest)) {
				const { collectionName, schemaInstance } = UserInfoSchema
				type UserInfo = InferSchemaType<typeof schemaInstance>
				const username = updateOrCreateUserInfoRequest.username

				if (username) {
					const getUserInfoWhere: QueryType<UserInfo> = {
						username: { $regex: new RegExp(`\\b${updateOrCreateUserInfoRequest.username}\\b`, 'iu') },
					}
					const getUserInfoSelect: SelectType<UserInfo> = {
						uid: 1,
						username: 1,
					}
					const verificationCodeResult = await selectDataFromMongoDB<UserInfo>(getUserInfoWhere, getUserInfoSelect, schemaInstance, collectionName)

					let isSafeUsername = false
					if (verificationCodeResult.success) {
						if (verificationCodeResult.result.length === 0) {
							isSafeUsername = true
						}
						if (verificationCodeResult.result.length === 1) {
							if (verificationCodeResult.result[0].uid === uid) {
								isSafeUsername = true
							}
						}
					}

					if (!isSafeUsername) {
						console.error('ERROR', '更新用户信息失败，用户重名', { updateOrCreateUserInfoRequest, uid })
						return { success: false, message: '更新用户信息失败，用户重名' }
					}
				}

				const updateUserInfoWhere: QueryType<UserInfo> = {
					uid,
				}
				const updateUserInfoUpdate: UpdateType<UserInfo> = {
					...updateOrCreateUserInfoRequest,
					label: updateOrCreateUserInfoRequest.label as UserInfo['label'], // TODO: Mongoose issue: #12420
					userLinkAccounts: updateOrCreateUserInfoRequest.userLinkAccounts as UserInfo['userLinkAccounts'], // TODO: Mongoose issue: #12420
					isUpdatedAfterReview: true,
					editDateTime: new Date().getTime(),
				}
				const updateResult = await findOneAndUpdateData4MongoDB(updateUserInfoWhere, updateUserInfoUpdate, schemaInstance, collectionName)
				if (updateResult && updateResult.success && updateResult.result) {
					return { success: true, message: '更新用户信息成功', result: updateResult.result }
				} else {
					console.error('ERROR', '更新用户信息失败，没有返回用户数据', { updateOrCreateUserInfoRequest, uid })
					return { success: false, message: '更新用户信息失败，没有返回用户数据' }
				}
			} else {
				console.error('ERROR', '更新用户信息时失败，未找到必要的数据，或者关联账户平台类型不合法：', { updateOrCreateUserInfoRequest, uid })
				return { success: false, message: '更新用户数据时失败，必要的数据为空或关联平台信息出错' }
			}
		} else {
			console.error('ERROR', '更新用户数据时失败，token 校验失败，非法用户！', { updateOrCreateUserInfoRequest, uid })
			return { success: false, message: '更新用户数据时失败，非法用户！' }
		}
	} catch (error) {
		console.error('ERROR', '更新用户信息时失败，未知异常', error)
		return { success: false, message: '更新用户数据时失败，未知异常' }
	}
}

/**
 * 根据 UID 获取用户是否存在
 * @param UserExistsCheckByUIDRequestDto 获取用户是否存在的请求参数
 * @returns 获取用户是否存在的请求结果
 */
export const checkUserExistsByUIDService = async (userExistsCheckByUIDRequest: UserExistsCheckByUIDRequestDto): Promise<UserExistsCheckByUIDResponseDto> => {
	try {
		if (!!userExistsCheckByUIDRequest.uid) {
			const { uid } = userExistsCheckByUIDRequest
			const { collectionName, schemaInstance } = UserInfoSchema
			type UserInfo = InferSchemaType<typeof schemaInstance>
			const where: QueryType<UserInfo> = { uid }
			const select: SelectType<UserInfo> = { uid: 1 }
			const result = await selectDataFromMongoDB<UserInfo>(where, select, schemaInstance, collectionName)
			if (result.success) {
				if (result.result?.length === 1) {
					return { success: true, exists: true, message: '用户存在' }
				} else {
					return { success: true, exists: false, message: '用户不存在' }
				}
			} else {
				console.error('ERROR', '获取用户是否存在时失败，查询失败')
				return { success: false, exists: false, message: '获取用户是否存在时失败，查询失败' }
			}
		} else {
			console.error('ERROR', '获取用户是否存在时失败，请求参数不合法')
			return { success: false, exists: false, message: '获取用户是否存在时失败，请求参数不合法' }
		}
	} catch (error) {
		console.error('ERROR', '获取用户是否存在时失败，未知异常', error)
		return { success: false, exists: false, message: '获取用户是否存在时失败，未知异常' }
	}
}

/**
 * 【已废弃】通过 uid 获取当前登录的用户信息
 * // DELETE ME: 禁止使用！该 API 应随着 UUID 普及逐渐被替换
 * @param getSelfUserInfoRequest 获取当前登录的用户信息的请求参数
 * @returns 获取到的当前登录的用户信息
 */
export const getSelfUserInfoService = async (getSelfUserInfoRequest: GetSelfUserInfoRequestDto): Promise<GetSelfUserInfoResponseDto> => {
	try {
		const { uid, token } = getSelfUserInfoRequest
		if (uid !== null && uid !== undefined && token) {
			if (await checkUserToken(uid, token)) {
				const { collectionName: userAuthCollectionName, schemaInstance: userAuthSchemaInstance } = UserAuthSchema
				type UserAuth = InferSchemaType<typeof userAuthSchemaInstance>
				const userAuthWhere: QueryType<UserAuth> = { uid }
				const userAuthSelect: SelectType<UserAuth> = {
					email: 1, // 用户邮箱
					userCreateDateTime: 1, // 用户创建日期
					role: 1, // 用户的角色
					uid: 1, // 用户 UID
					UUID: 1, // UUID
					authenticatorType: 1, // 2FA 的类型
				}

				const { collectionName: userInfoCollectionName, schemaInstance: userInfoSchemaInstance } = UserInfoSchema
				type UserInfo = InferSchemaType<typeof userInfoSchemaInstance>
				const getUserInfoWhere: QueryType<UserInfo> = { uid }
				const getUserInfoSelect: SelectType<UserInfo> = {
					uid: 1, // 用户 UID
					UUID: 1, // UUID
					label: 1, // 用户标签
					username: 1, // 用户名
					userNickname: 1, // 用户昵称
					avatar: 1, // 用户头像
					userBannerImage: 1, // 用户的背景图
					signature: 1, // 用户的个性签名
					gender: 1, // 用户的性别
				}

				try {
					const userAuthPromise = selectDataFromMongoDB<UserAuth>(userAuthWhere, userAuthSelect, userAuthSchemaInstance, userAuthCollectionName)
					const userInfoPromise = selectDataFromMongoDB(getUserInfoWhere, getUserInfoSelect, userInfoSchemaInstance, userInfoCollectionName)
					const [userAuthResult, userInfoResult] = await Promise.all([userAuthPromise, userInfoPromise])
					if (userInfoResult && userAuthResult && userInfoResult.success && userAuthResult.success) {
						const userAuth = userAuthResult?.result
						const userInfo = userInfoResult?.result
						if (userAuth?.length === 0 || userInfo?.length === 0) {
							return { success: true, message: '用户未填写用户信息', result: { uid, email: userAuth?.[0]?.email, userCreateDateTime: userAuth[0].userCreateDateTime, role: userAuth[0].role, typeOf2FA: userAuth[0].authenticatorType } }
						} else if (userAuth?.length === 1 && userAuth?.[0] && userInfo?.length === 1 && userInfo?.[0]) {
							return { success: true, message: '获取用户信息成功', result: { ...userInfo[0], email: userAuth[0].email, userCreateDateTime: userAuth[0].userCreateDateTime, role: userAuth[0].role, typeOf2FA: userAuth[0].authenticatorType } }
						} else {
							console.error('ERROR', '获取用户信息时失败，获取到的结果长度不为 1')
							return { success: false, message: '获取用户信息时失败，结果异常' }
						}
					} else {
						console.error('ERROR', '获取用户信息时失败，获取到的结果为空')
						return { success: false, message: '获取用户信息时失败，结果为空' }
					}
				} catch (error) {
					console.error('ERROR', '获取用户信息时失败，查询数据时出错：', error)
					return { success: false, message: '获取用户信息时失败' }
				}
			} else {
				console.error('ERROR', '获取用户信息时失败，用户的 token 校验未通过，非法用户！')
				return { success: false, message: '获取用户信息时失败，非法用户！' }
			}
		} else {
			console.error('ERROR', '获取用户信息时失败，uid 或 token 为空')
			return { success: false, message: '获取用户信息时失败，必要的参数为空' }
		}
	} catch (error) {
		console.error('ERROR', '获取用户信息时失败，未知错误：', error)
		return { success: false, message: '获取用户信息时失败，未知错误' }
	}
}

/**
 * 通过 UUID 获取当前登录的用户信息
 * @param getSelfUserInfoRequest 通过 UUID 获取当前登录的用户信息的请求参数
 * @returns 通过 UUID 获取当前登录的用户信息的请求响应
 */
export const getSelfUserInfoByUuidService = async (getSelfUserInfoByUuidRequest: GetSelfUserInfoByUuidRequestDto): Promise<GetSelfUserInfoByUuidResponseDto> => {
	try {
		const { uuid, token } = getSelfUserInfoByUuidRequest
		if (!uuid || !token) {
			console.error('ERROR', '通过 UUID 获取用户信息失败，uuid 或 token 为空')
			return { success: false, message: '通过 UUID 获取用户信息失败，必要的参数为空' }
		}

		if (!await checkUserTokenByUUID(uuid, token)) {
			console.error('ERROR', '通过 UUID 获取用户信息时失败，用户的 token 校验未通过，非法用户！')
			return { success: false, message: '通过 UUID 获取用户信息时失败，非法用户！' }
		}

		const { collectionName: userAuthCollectionName, schemaInstance: userAuthSchemaInstance } = UserAuthSchema
		const { collectionName: userInfoCollectionName, schemaInstance: userInfoSchemaInstance } = UserInfoSchema

		type UserAuth = InferSchemaType<typeof userAuthSchemaInstance>
		type UserInfo = InferSchemaType<typeof userInfoSchemaInstance>

		const where: QueryType<UserAuth> | QueryType<UserInfo> = { UUID: uuid }

		const userAuthSelect: SelectType<UserAuth> = {
			email: 1, // 用户邮箱
			userCreateDateTime: 1, // 用户创建日期
			role: 1, // 用户的角色
			uid: 1, // 用户 UID
			UUID: 1, // UUID
		}
		const getUserInfoSelect: SelectType<UserInfo> = {
			uid: 1, // 用户 UID
			UUID: 1, // UUID
			label: 1, // 用户标签
			username: 1, // 用户名
			userNickname: 1, // 用户昵称
			avatar: 1, // 用户头像
			userBannerImage: 1, // 用户的背景图
			signature: 1, // 用户的个性签名
			gender: 1, // 用户的性别
		}

		try {
			const userAuthPromise = selectDataFromMongoDB<UserAuth>(where, userAuthSelect, userAuthSchemaInstance, userAuthCollectionName)
			const userInfoPromise = selectDataFromMongoDB<UserInfo>(where, getUserInfoSelect, userInfoSchemaInstance, userInfoCollectionName)
			const [userAuthResult, userInfoResult] = await Promise.all([userAuthPromise, userInfoPromise])
			if (userInfoResult && userAuthResult && userInfoResult.success && userAuthResult.success) {
				const userAuth = userAuthResult?.result
				const userInfo = userInfoResult?.result
				if (userAuth?.length === 0 || userInfo?.length === 0) {
					return { success: true, message: '用户未填写用户信息', result: { uuid, email: userAuth?.[0]?.email, userCreateDateTime: userAuth[0].userCreateDateTime, role: userAuth[0].role } }
				} else if (userAuth?.length === 1 && userAuth?.[0] && userInfo?.length === 1 && userInfo?.[0]) {
					return { success: true, message: '获取用户信息成功', result: { ...userInfo[0], email: userAuth[0].email, userCreateDateTime: userAuth[0].userCreateDateTime, role: userAuth[0].role } }
				} else {
					console.error('ERROR', '通过 UUID 获取用户信息时失败，获取到的结果长度不为 1')
					return { success: false, message: '通过 UUID 获取用户信息时失败，结果异常' }
				}
			} else {
				console.error('ERROR', '通过 UUID 获取用户信息时失败，获取到的结果为空')
				return { success: false, message: '通过 UUID 获取用户信息时失败，结果为空' }
			}
		} catch (error) {
			console.error('ERROR', '通过 UUID 获取用户信息时出错，查询数据时出错：', error)
			return { success: false, message: '通过 UUID 获取用户信息时出错' }
		}
	} catch (error) {
		console.error('ERROR', '通过 UUID 获取用户信息时出错，未知错误：', error)
		return { success: false, message: '通过 UUID 获取用户信息时出错，未知错误' }
	}
}


/**
 * 通过 uid 获取（其他）用户信息
 * @param uid 用户 ID
 * @returns 获取用户信息的请求结果
 */
export const getUserInfoByUidService = async (getUserInfoByUidRequest: GetUserInfoByUidRequestDto): Promise<GetUserInfoByUidResponseDto> => {
	try {
		const uid = getUserInfoByUidRequest?.uid
		if (uid !== null && uid !== undefined) {
			const { collectionName: userAuthCollectionName, schemaInstance: userAuthSchemaInstance } = UserAuthSchema
			type UserAuth = InferSchemaType<typeof userAuthSchemaInstance>
			const userAuthWhere: QueryType<UserAuth> = { uid }
			const userAuthSelect: SelectType<UserAuth> = {
				userCreateDateTime: 1, // 用户创建日期
				role: 1, // 用户的角色
			}

			const { collectionName: userInfoCollectionName, schemaInstance: userInfoSchemaInstance } = UserInfoSchema
			type UserInfo = InferSchemaType<typeof userInfoSchemaInstance>
			const getUserInfoWhere: QueryType<UserInfo> = { uid }
			const getUserInfoSelect: SelectType<UserInfo> = {
				label: 1, // 用户标签
				username: 1, // 用户名
				userNickname: 1, // 用户昵称
				avatar: 1, // 用户头像
				userBannerImage: 1, // 用户的背景图
				signature: 1, // 用户的个性签名
				gender: 1, // 用户的性别
			}

			try {
				const userAuthPromise = selectDataFromMongoDB<UserAuth>(userAuthWhere, userAuthSelect, userAuthSchemaInstance, userAuthCollectionName)
				const userInfoPromise = selectDataFromMongoDB(getUserInfoWhere, getUserInfoSelect, userInfoSchemaInstance, userInfoCollectionName)
				const [userAuthResult, userInfoResult] = await Promise.all([userAuthPromise, userInfoPromise])
				if (userAuthResult && userAuthResult.success && userInfoResult && userInfoResult.success) {
					const userAuth = userAuthResult?.result
					const userInfo = userInfoResult?.result
					if (userInfo?.length === 1 && userInfo?.[0]) {
						return { success: true, message: '获取用户信息成功', result: { ...userInfo[0], userCreateDateTime: userAuth[0].userCreateDateTime, role: userAuth[0].role } }
					} else {
						console.error('ERROR', '获取用户信息时失败，获取到的结果长度不为 1')
						return { success: false, message: '获取用户信息时失败，结果异常' }
					}
				} else {
					console.error('ERROR', '获取用户信息时失败，获取到的结果为空')
					return { success: false, message: '获取用户信息时失败，结果为空' }
				}
			} catch (error) {
				console.error('ERROR', '获取用户信息时失败，查询数据时出错：0', error)
				return { success: false, message: '获取用户信息时失败' }
			}
		} else {
			console.error('ERROR', '获取用户信息时失败，uid 或 token 为空')
			return { success: false, message: '获取用户信息时失败，必要的参数为空' }
		}
	} catch (error) {
		console.error('ERROR', '获取用户信息时失败，未知错误：', error)
		return { success: false, message: '获取用户信息时失败，未知错误' }
	}
}

/**
 * 更新用户头像，并获取用于用户上传头像的预签名 URL, 上传限时 60 秒
 * @param uid 用户 ID
 * @param token 用户 token
 * @returns 用于用户上传头像的预签名 URL 的结果
 */
export const getUserAvatarUploadSignedUrlService = async (uid: number, token: string): Promise<GetUserAvatarUploadSignedUrlResponseDto> => {
	// TODO 图片上传逻辑需要重写，当前如何用户上传图片失败，仍然会用新头像链接替换数据库中的旧头像链接，而且当前图片没有加入审核流程
	try {
		if (await checkUserToken(uid, token)) {
			const now = new Date().getTime()
			const fileName = `avatar-${uid}-${generateSecureRandomString(32)}-${now}`
			const signedUrl = await createCloudflareImageUploadSignedUrl(fileName, 660)
			if (signedUrl && fileName) {
				return { success: true, message: '准备开始上传头像', userAvatarUploadSignedUrl: signedUrl, userAvatarFilename: fileName }
			} else {
				// TODO 图片上传逻辑需要重写，当前如何用户上传图片失败，仍然会用新头像链接替换数据库中的旧头像链接，而且当前图片没有加入审核流程
				return { success: false, message: '上传失败，无法生成图片上传 URL，请重新上传头像' }
			}
		} else {
			console.error('ERROR', '获取上传图片用的预签名 URL 失败，用户不合法', { uid })
			return { success: false, message: '上传失败，无法获取上传权限' }
		}
	} catch (error) {
		console.error('ERROR', '获取上传图片用的预签名 URL 失败，错误信息', error, { uid })
	}
}

/**
 * 获取用户个性设置数据
 * @param uid 用户 ID
 * @param token 用户 token
 * @returns 用户个性设置数据
 */
export const getUserSettingsService = async (uid: number, token: string): Promise<GetUserSettingsResponseDto> => {
	try {
		if (await checkUserToken(uid, token)) {
			const { collectionName, schemaInstance } = UserSettingsSchema
			type UserSettings = InferSchemaType<typeof schemaInstance>
			const getUserSettingsWhere: QueryType<UserSettings> = {
				uid,
			}
			const getUserSettingsSelect: SelectType<UserSettings> = {
				uid: 1,
				enableCookie: 1,
				themeType: 1,
				themeColor: 1,
				themeColorCustom: 1,
				wallpaper: 1,
				coloredSideBar: 1,
				dataSaverMode: 1,
				noSearchRecommendations: 1,
				noRelatedVideos: 1,
				noRecentSearch: 1,
				noViewHistory: 1,
				openInNewWindow: 1,
				currentLocale: 1,
				timezone: 1,
				unitSystemType: 1,
				devMode: 1,
				showCssDoodle: 1,
				sharpAppearanceMode: 1,
				flatAppearanceMode: 1,
				userLinkAccountsPrivacySetting: 1,
				userWebsitePrivacySetting: 1,
				editDateTime: 1,
			}
			try {
				const userSettingsResult = await selectDataFromMongoDB(getUserSettingsWhere, getUserSettingsSelect, schemaInstance, collectionName)
				const userSettings = userSettingsResult?.result?.[0]
				if (userSettingsResult?.success && userSettings) {
					return { success: true, message: '获取用户设置成功！', userSettings }
				} else {
					console.error('ERROR', '获取用户个性设置失败，查询成功，但获取数据失败或数据为空：', { uid })
					return { success: false, message: '获取用户个性设置失败，数据查询未成功' }
				}
			} catch (error) {
				console.error('ERROR', '获取用户个性设置失败，查询数据时出错：', { uid })
				return { success: false, message: '获取用户个性设置失败，查询数据时出错' }
			}
		} else {
			console.error('ERROR', '获取用户个性设置失败，用户验证时未通过：', { uid })
			return { success: false, message: '获取用户个性设置失败，用户验证时未通过' }
		}
	} catch (error) {
		console.error('ERROR', '获取用户个性设置失败，未知异常：', error)
		return { success: false, message: '获取用户个性设置失败，未知异常' }
	}
}

/**
 * 根据 UID 更新或创建用户设置
 * @param updateOrCreateUserSettingsRequest 更新或创建用户设置时的请求参数
 * @param uid 用户 ID
 * @param token 用户 token
 * @returns 更新或创建用户设置的请求结果
 */
export const updateOrCreateUserSettingsService = async (updateOrCreateUserSettingsRequest: UpdateOrCreateUserSettingsRequestDto, uid: number, token: string): Promise<UpdateOrCreateUserSettingsResponseDto> => {
	try {
		if (await checkUserToken(uid, token)) {
			const UUID = await getUserUuid(uid) // DELETE ME 这是一个临时解决方法，Cookie 中应当存储 UUID
			if (!UUID) {
				console.error('ERROR', '更新或创建用户设置失败，UUID 不存在', { updateOrCreateUserSettingsRequest, uid })
				return { success: false, message: '更新或创建用户设置失败，UUID 不存在' }
			}

			if (checkUpdateOrCreateUserSettingsRequest(updateOrCreateUserSettingsRequest)) {
				const { collectionName, schemaInstance } = UserSettingsSchema
				type UserSettings = InferSchemaType<typeof schemaInstance>
				const updateOrCreateUserSettingsWhere: QueryType<UserSettings> = {
					uid,
				}
				const updateOrCreateUserSettingsUpdate: UpdateType<UserSettings> = {
					...updateOrCreateUserSettingsRequest,
					userLinkAccountsPrivacySetting: updateOrCreateUserSettingsRequest.userLinkAccountsPrivacySetting as UserSettings['userLinkAccountsPrivacySetting'], // TODO: Mongoose issue: #12420
					editDateTime: new Date().getTime(),
				}
				const updateResult = await findOneAndUpdateData4MongoDB(updateOrCreateUserSettingsWhere, updateOrCreateUserSettingsUpdate, schemaInstance, collectionName)
				const userSettings = updateResult?.result?.[0]
				if (updateResult?.success) {
					return { success: true, message: '更新或创建用户设置成功', userSettings: userSettings || updateOrCreateUserSettingsUpdate }
				} else {
					console.error('ERROR', '更新或创建用户设置失败，没有返回用户设置数据', { updateOrCreateUserSettingsRequest, uid })
					return { success: false, message: '更新或创建用户设置失败，没有返回用户设置数据' }
				}
			} else {
				console.error('ERROR', '更新或创建用户设置失败，未找到必要的数据，或者关联账户平台类型不合法：', { updateOrCreateUserSettingsRequest, uid })
				return { success: false, message: '更新或创建用户设置失败，必要的数据为空或关联平台信息出错' }
			}
		} else {
			console.error('ERROR', '更新或创建用户设置失败，token 校验失败，非法用户！', { updateOrCreateUserSettingsRequest, uid })
			return { success: false, message: '更新或创建用户设置失败，非法用户！' }
		}
	} catch (error) {
		console.error('ERROR', '更新或创建用户设置时失败，未知异常', error)
		return { success: false, message: '更新或创建用户设置失败，未知异常' }
	}
}

/**
 * 用户校验
 * @param uid 用户 ID, 为空时会导致校验失败
 * @param token 用户 ID 对应的 token，为空时会导致校验失败
 * @returns 校验结果
 */
export const checkUserTokenService = async (uid: number, token: string): Promise<CheckUserTokenResponseDto> => {
	try {
		if (uid !== undefined && uid !== null && token) {
			const checkUserTokenResult = await checkUserToken(uid, token)
			if (checkUserTokenResult) {
				return { success: true, message: '用户校验成功', userTokenOk: true }
			} else {
				console.error('ERROR', `用户校验失败！非法用户！用户 UID：${uid}`)
				return { success: false, message: '用户校验失败！非法用户！', userTokenOk: false }
			}
		} else {
			console.error('ERROR', `用户校验失败！用户 uid 或 token 不存在，用户 UID：${uid}`)
			return { success: false, message: '用户校验失败！', userTokenOk: false }
		}
	} catch {
		console.error('ERROR', `用户校验异常！用户 UID：${uid}`)
		return { success: false, message: '用户校验异常！', userTokenOk: false }
	}
}

/**
 * 通过 UUID 校验用户
 * @param UUID 用户 UUID
 * @param token 用户 ID 对应的 token，为空时会导致校验失败
 * @returns 校验结果
 */
export const checkUserTokenByUuidService = async (UUID: string, token: string): Promise<CheckUserTokenResponseDto> => {
	try {
		if (UUID !== undefined && UUID !== null && token) {
			const checkUserTokenResult = await checkUserTokenByUUID(UUID, token)
			if (checkUserTokenResult) {
				return { success: true, message: '用户校验成功', userTokenOk: true }
			} else {
				console.error('ERROR', `用户校验失败！非法用户！用户 UUID：${UUID}`)
				return { success: false, message: '用户校验失败！非法用户！', userTokenOk: false }
			}
		} else {
			console.error('ERROR', `用户校验失败！用户 UUID 或 token 不存在，用户 UUID：${UUID}`)
			return { success: false, message: '用户校验失败！', userTokenOk: false }
		}
	} catch {
		console.error('ERROR', `用户校验异常！用户 UUID：${UUID}`)
		return { success: false, message: '用户校验异常！', userTokenOk: false }
	}
}

/**
 * 请求发送验证码
 * @param requestSendVerificationCodeRequest 请求发送验证码的请求载荷
 * @returns 请求发送验证码的请求响应
 */
export const RequestSendVerificationCodeService = async (requestSendVerificationCodeRequest: RequestSendVerificationCodeRequestDto): Promise<RequestSendVerificationCodeResponseDto> => {
	try {
		if (checkRequestSendVerificationCodeRequest(requestSendVerificationCodeRequest)) {
			const { email, clientLanguage } = requestSendVerificationCodeRequest
			const emailLowerCase = email.toLowerCase()
			const nowTime = new Date().getTime()
			const todayStart = new Date()
			todayStart.setHours(0, 0, 0, 0)
			const { collectionName, schemaInstance } = UserVerificationCodeSchema
			type UserVerificationCode = InferSchemaType<typeof schemaInstance>
			const requestSendVerificationCodeWhere: QueryType<UserVerificationCode> = {
				emailLowerCase,
			}

			const requestSendVerificationCodeSelect: SelectType<UserVerificationCode> = {
				emailLowerCase: 1, // 用户邮箱
				attemptsTimes: 1,
				lastRequestDateTime: 1, // 用户上一次请求验证码的时间，用于防止滥用
			}

			// 启动事务
			const session = await mongoose.startSession()
			session.startTransaction()

			try {
				const requestSendVerificationCodeResult = await selectDataFromMongoDB<UserVerificationCode>(requestSendVerificationCodeWhere, requestSendVerificationCodeSelect, schemaInstance, collectionName, { session })
				if (requestSendVerificationCodeResult.success) {
					const lastRequestDateTime = requestSendVerificationCodeResult.result?.[0]?.lastRequestDateTime ?? 0
					const attemptsTimes = requestSendVerificationCodeResult.result?.[0]?.attemptsTimes ?? 0
					if (requestSendVerificationCodeResult.result.length === 0 || lastRequestDateTime + 55000 < nowTime) { // 前端 60 秒，后端 55 秒
						const lastRequestDate = new Date(lastRequestDateTime)
						if (requestSendVerificationCodeResult.result.length === 0 || todayStart > lastRequestDate || attemptsTimes < 5) { // ! 每天五次机会
							const verificationCode = generateSecureVerificationNumberCode(6) // 生成六位随机数验证码
							let newAttemptsTimes = attemptsTimes + 1
							if (todayStart > lastRequestDate) {
								newAttemptsTimes = 0
							}

							const requestSendVerificationCodeUpdate: UserVerificationCode = {
								emailLowerCase,
								verificationCode,
								overtimeAt: nowTime + 1800000, // 当前时间加上 1800000 毫秒（30 分钟）作为新的过期时间
								attemptsTimes: newAttemptsTimes,
								lastRequestDateTime: nowTime,
								editDateTime: nowTime,
							}
							const updateResult = await findOneAndUpdateData4MongoDB(requestSendVerificationCodeWhere, requestSendVerificationCodeUpdate, schemaInstance, collectionName, { session })
							if (updateResult.success) {
								// TODO: 使用多语言 email title and text
								try {
									const mailTitleCHS = 'KIRAKIRA 注册验证码'
									const mailTitleEN = 'KIRAKIRA Registration Verification Code'
									const correctMailTitle = clientLanguage === 'zh-Hans-CN' ? mailTitleCHS : mailTitleEN

									// 请不要使用 “您”
									const mailHtmlCHS = `
											<p>你的注册验证码是：<strong>${verificationCode}</strong></p>
											欢迎来到 KIRAKIRA，使用这个验证码来完成注册吧！
											<br>
											验证码 30 分钟内有效。请注意安全，不要向他人泄露你的验证码。
										`
									const mailHtmlEN = `
											<p>Your registration verification code is: <strong>${verificationCode}</strong></p>
											Welcome to KIRAKIRA. You can use this verification code to register your account.
											<br>
											Verification code is valid for 30 minutes. Please ensure do not disclose your verification code to others.
											<br>
											<br>
											To stop receiving notifications, please contact the KIRAKIRA support team.
										`
									const correctMailHTML = clientLanguage === 'zh-Hans-CN' ? mailHtmlCHS : mailHtmlEN
									const sendMailResult = await sendMail(email, correctMailTitle, { html: correctMailHTML })
									if (sendMailResult.success) {
										await session.commitTransaction()
										session.endSession()
										return { success: true, isTimeout: false, message: '注册验证码已发送至你注册时使用的邮箱，请注意查收，如未收到，请检查垃圾箱或联系 KIRAKIRA 客服。' }
									} else {
										if (session.inTransaction()) {
											await session.abortTransaction()
										}
										session.endSession()
										console.error('ERROR', '请求发送注册验证码失败，邮件发送失败')
										return { success: false, isTimeout: true, message: '请求发送注册验证码失败，邮件发送失败' }
									}
								} catch (error) {
									if (session.inTransaction()) {
										await session.abortTransaction()
									}
									session.endSession()
									console.error('ERROR', '请求发送注册验证码失败，邮件发送时出错', error)
									return { success: false, isTimeout: true, message: '请求发送注册验证码失败，邮件发送时出错' }
								}
							} else {
								if (session.inTransaction()) {
									await session.abortTransaction()
								}
								session.endSession()
								console.error('ERROR', '请求发送注册验证码失败，更新或新增用户验证码失败')
								return { success: false, isTimeout: false, message: '请求发送注册验证码失败，更新或新增用户验证码失败' }
							}
						} else {
							if (session.inTransaction()) {
								await session.abortTransaction()
							}
							session.endSession()
							console.warn('WARN', 'WARNING', '请求发送注册验证码失败，已达本日重复次数上限，请稍后再试')
							return { success: true, isTimeout: true, message: '请求发送注册验证码失败，已达本日重复次数上限，请稍后再试' }
						}
					} else {
						if (session.inTransaction()) {
							await session.abortTransaction()
						}
						session.endSession()
						console.warn('WARN', 'WARNING', '请求发送注册验证码失败，未超过邮件超时时间，请稍后再试')
						return { success: true, isTimeout: true, message: '请求发送注册验证码失败，未超过邮件超时时间，请稍后再试' }
					}
				} else {
					if (session.inTransaction()) {
						await session.abortTransaction()
					}
					session.endSession()
					console.error('ERROR', '请求发送注册验证码失败，获取验证码失败')
					return { success: false, isTimeout: false, message: '请求发注册送验证码失败，获取验证码失败' }
				}
			} catch (error) {
				if (session.inTransaction()) {
					await session.abortTransaction()
				}
				session.endSession()
				console.error('ERROR', '请求发送注册验证码失败，检查超时时间时出错', error)
				return { success: false, isTimeout: false, message: '请求发送注册验证码失败，检查超时时间时出错' }
			}
		} else {
			console.error('ERROR', '请求发送注册验证码失败，参数不合法')
			return { success: false, isTimeout: false, message: '请求发送注册验证码失败，参数不合法' }
		}
	} catch (error) {
		console.error('ERROR', '请求发送注册验证码失败，未知错误', error)
		return { success: false, isTimeout: false, message: '请求发送注册验证码失败，未知错误' }
	}
}

/**
 * 生成邀请码
 * @param uid 申请生成邀请码的用户
 * @param token 申请生成邀请码的用户 token
 * @returns 生成的邀请码
 */
export const createInvitationCodeService = async (uid: number, token: string): Promise<CreateInvitationCodeResponseDto> => {
	try {
		if (await checkUserToken(uid, token)) {
			const UUID = await getUserUuid(uid) // DELETE ME 这是一个临时解决方法，Cookie 中应当存储 UUID
			if (!UUID) {
				console.error('ERROR', '生成邀请码失败，UUID 不存在', { uid })
				return { success: false, isCoolingDown: false, message: '生成邀请码失败，UUID 不存在' }
			}

			const nowTime = new Date().getTime()
			const sevenDaysInMillis = 7 * 24 * 60 * 60 * 1000 // 将七天的时间转换为毫秒
			const { collectionName, schemaInstance } = UserInvitationCodeSchema
			type UserInvitationCode = InferSchemaType<typeof schemaInstance>
			const userInvitationCodeWhere: QueryType<UserInvitationCode> = {
				creatorUid: uid,
				generationDateTime: { $gt: nowTime - sevenDaysInMillis },
			}

			const userInvitationCodeSelect: SelectType<UserInvitationCode> = {
				creatorUid: 1,
			}

			try {
				const userInvitationCodeSelectResult = await selectDataFromMongoDB<UserInvitationCode>(userInvitationCodeWhere, userInvitationCodeSelect, schemaInstance, collectionName)
				const isAdmin = await checkUserRoleService(uid, 'admin')

				/** 如果不是管理员，而且用户创建时间不在七天前 */
				if (!isAdmin) {
					try {
						const getSelfUserInfoRequest: GetSelfUserInfoRequestDto = {
							uid,
							token,
						}
						const selfUserInfo = await getSelfUserInfoService(getSelfUserInfoRequest)
						if (!selfUserInfo.success || selfUserInfo.result.userCreateDateTime > nowTime - sevenDaysInMillis) {
							console.warn('WARN', 'WARNING', '生成邀请码失败，未超出邀请码生成期限，正在冷却中（第一次）', { uid })
							return { success: true, isCoolingDown: true, message: '生成邀请码失败，未超出邀请码生成期限，正在冷却中（第一次）' }
						}
					} catch (error) {
						console.warn('WARN', 'WARNING', '生成邀请码时出错，查询用户信息出错', { error, uid })
						return { success: false, isCoolingDown: false, message: '生成邀请码时出错，查询用户信息出错' }
					}
				}
				if (isAdmin || (userInvitationCodeSelectResult.success && userInvitationCodeSelectResult.result?.length === 0)) { // 是管理员或者没有找到一天内的邀请码，则可以生成邀请码。
					try {
						const charset = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
						let finalInvitationCode = ''
						while (true) { // 不断循环生成邀请码，直到生成一个不重复的邀请码
							const invitationCodePart1 = generateSecureVerificationStringCode(4, charset)
							const invitationCodePart2 = generateSecureVerificationStringCode(4, charset)
							const newInvitationCode = `KIRA-${invitationCodePart1}-${invitationCodePart2}`

							const userInvitationCodeDuplicationCheckWhere: QueryType<UserInvitationCode> = {
								invitationCode: newInvitationCode,
							}

							const userInvitationCodeDuplicationCheckSelect: SelectType<UserInvitationCode> = {
								creatorUid: 1,
							}

							const userInvitationCodeDuplicationCheckResult = await selectDataFromMongoDB<UserInvitationCode>(userInvitationCodeDuplicationCheckWhere, userInvitationCodeDuplicationCheckSelect, schemaInstance, collectionName)
							const noSame = userInvitationCodeDuplicationCheckResult.result?.length === 0
							if (noSame) {
								finalInvitationCode = newInvitationCode
								break
							}
						}

						if (finalInvitationCode) {
							const userInvitationCode: UserInvitationCode = {
								creatorUUID: UUID,
								creatorUid: uid,
								isPending: false,
								disabled: false,
								invitationCode: finalInvitationCode,
								generationDateTime: nowTime,
								editDateTime: nowTime,
								createDateTime: nowTime,
							}

							try {
								const insertResult = await insertData2MongoDB(userInvitationCode, schemaInstance, collectionName)
								if (insertResult.success) {
									return { success: true, isCoolingDown: false, message: '生成邀请码成功', invitationCodeResult: userInvitationCode }
								} else {
									console.error('ERROR', '生成邀请码失败，存储邀请码失败', { uid })
									return { success: false, isCoolingDown: false, message: '生成邀请码失败，存储邀请码失败' }
								}
							} catch (error) {
								console.error('ERROR', '生成邀请码失败，存储邀请码时出错', error, { uid })
								return { success: false, isCoolingDown: false, message: '生成邀请码失败，存储邀请码时出错' }
							}
						} else {
							console.error('ERROR', '生成邀请码失败，生成不重复的新邀请码失败', { uid })
							return { success: false, isCoolingDown: false, message: '生成邀请码失败，生成不重复的新邀请码失败' }
						}
					} catch (error) {
						console.error('ERROR', '生成邀请码失败，生成不重复的新邀请码时出错', error, { uid })
						return { success: false, isCoolingDown: false, message: '生成邀请码失败，生成不重复的新邀请码时出错' }
					}
				} else {
					console.warn('WARN', 'WARNING', '生成邀请码失败，未超出邀请码生成期限，正在冷却中', { uid })
					return { success: true, isCoolingDown: true, message: '生成邀请码失败，未超出邀请码生成期限，正在冷却中' }
				}
			} catch (error) {
				console.error('ERROR', '生成邀请码失败，查询是否超出邀请码生成期限时出错', error, { uid })
				return { success: false, isCoolingDown: true, message: '生成邀请码失败，查询是否超出邀请码生成期限出错' }
			}
		} else {
			console.error('ERROR', '生成邀请码失败，非法用户！', { uid })
			return { success: false, isCoolingDown: false, message: '生成邀请码失败，非法用户！' }
		}
	} catch (error) {
		console.error('ERROR', '生成邀请码失败，未知错误', error)
		return { success: false, isCoolingDown: false, message: '生成邀请码失败，未知错误' }
	}
}

/**
 * 获取自己的邀请码列表
 * @param uid 用户 UID
 * @param token 用户 token
 * @returns 获取自己的邀请码列表的请求结果
 */
export const getMyInvitationCodeService = async (uid: number, token: string): Promise<GetMyInvitationCodeResponseDto> => {
	try {
		if (await checkUserToken(uid, token)) {
			const { collectionName, schemaInstance } = UserInvitationCodeSchema
			type UserInvitationCode = InferSchemaType<typeof schemaInstance>
			const myInvitationCodeWhere: QueryType<UserInvitationCode> = {
				creatorUid: uid,
			}

			const myInvitationCodeSelect: SelectType<UserInvitationCode> = {
				creatorUid: 1,
				invitationCode: 1,
				generationDateTime: 1,
				isPending: 1,
				assignee: 1,
				usedDateTime: 1,
			}

			try {
				const myInvitationCodeResult = await selectDataFromMongoDB<UserInvitationCode>(myInvitationCodeWhere, myInvitationCodeSelect, schemaInstance, collectionName)
				if (myInvitationCodeResult.success) {
					if (myInvitationCodeResult.result?.length >= 0) {
						return { success: true, message: '已成功获取邀请码列表', invitationCodeResult: myInvitationCodeResult.result }
					} else {
						return { success: true, message: '自己的邀请码列表为空', invitationCodeResult: [] }
					}
				} else {
					console.error('ERROR', '获取自己的邀请码失败，请求失败', { uid })
					return { success: false, message: '获取自己的邀请码失败，请求失败！', invitationCodeResult: [] }
				}
			} catch (error) {
				console.error('ERROR', '获取自己的邀请码失败，请求时出错', { uid, error })
				return { success: false, message: '获取自己的邀请码失败，请求时出错！', invitationCodeResult: [] }
			}
		} else {
			console.error('ERROR', '获取自己的邀请码失败，非法用户！', { uid })
			return { success: false, message: '获取自己的邀请码失败，非法用户！', invitationCodeResult: [] }
		}
	} catch (error) {
		console.error('ERROR', '获取自己的邀请码失败，未知错误', error)
		return { success: false, message: '获取自己的邀请码失败，未知错误', invitationCodeResult: [] }
	}
}

/**
 * 使用邀请码注册
 * @param userInvitationCodeDto 使用邀请码注册的参数
 * @returns 使用邀请码注册的结果
 */
const useInvitationCode = async (useInvitationCodeDto: UseInvitationCodeDto): Promise<UseInvitationCodeResultDto> => {
	try {
		if (checkUseInvitationCodeDto(useInvitationCodeDto)) {
			const nowTime = new Date().getTime()
			const { collectionName, schemaInstance } = UserInvitationCodeSchema
			type UserInvitationCode = InferSchemaType<typeof schemaInstance>

			const useInvitationCodeWhere: QueryType<UserInvitationCode> = {
				invitationCode: useInvitationCodeDto.invitationCode,
				assignee: undefined,
				disabled: false,
			}
			const useInvitationCodeUpdate: UpdateType<UserInvitationCode> = {
				assignee: useInvitationCodeDto.registrantUid,
				assigneeUUID: useInvitationCodeDto.registrantUUID,
				usedDateTime: nowTime,
				editDateTime: nowTime,
			}

			try {
				const updateResult = await findOneAndUpdateData4MongoDB(useInvitationCodeWhere, useInvitationCodeUpdate, schemaInstance, collectionName)
				if (updateResult.success) {
					return { success: true, message: '已使用邀请码注册' }
				} else {
					console.error('ERROR', '使用邀请码注册，使用邀请码失败')
					return { success: false, message: '使用邀请码注册，使用邀请码失败' }
				}
			} catch (error) {
				console.error('ERROR', '使用邀请码注册，使用邀请码时出错', error)
				return { success: false, message: '使用邀请码注册，使用邀请码时出错' }
			}
		} else {
			console.error('ERROR', '使用邀请码注册，参数不合法')
			return { success: false, message: '使用邀请码注册，参数不合法' }
		}
	} catch (error) {
		console.error('ERROR', '使用邀请码注册，未知错误', error)
		return { success: false, message: '使用邀请码注册，未知错误' }
	}
}

/**
 * 检查一个邀请码是否可用
 * @param checkInvitationCodeRequestDto 检查一个邀请码是否可用的请求载荷
 * @returns 检查一个邀请码是否可用的请求响应
 */
export const checkInvitationCodeService = async (checkInvitationCodeRequestDto: CheckInvitationCodeRequestDto): Promise<CheckInvitationCodeResponseDto> => {
	try {
		if (checkCheckInvitationCodeRequestDto(checkInvitationCodeRequestDto)) {
			const { collectionName, schemaInstance } = UserInvitationCodeSchema
			type UserInvitationCode = InferSchemaType<typeof schemaInstance>
			const checkInvitationCodeWhere: QueryType<UserInvitationCode> = {
				invitationCode: checkInvitationCodeRequestDto.invitationCode,
				assignee: undefined,
				disabled: false,
			}

			const checkInvitationCodeSelect: SelectType<UserInvitationCode> = {
				invitationCode: 1,
			}

			try {
				const checkInvitationCodeResult = await selectDataFromMongoDB<UserInvitationCode>(checkInvitationCodeWhere, checkInvitationCodeSelect, schemaInstance, collectionName)
				if (checkInvitationCodeResult.success) {
					if (checkInvitationCodeResult.result?.length === 1) {
						return { success: true, isAvailableInvitationCode: true, message: '邀请码检查通过' }
					} else {
						return { success: true, isAvailableInvitationCode: false, message: '邀请码检查未通过' }
					}
				} else {
					console.error('ERROR', '检查邀请码可用性失败，请求失败')
					return { success: false, isAvailableInvitationCode: false, message: '检查邀请码可用性失败，请求失败！' }
				}
			} catch (error) {
				console.error('ERROR', '检查邀请码可用性失败，请求时出错')
				return { success: false, isAvailableInvitationCode: false, message: '检查邀请码可用性失败，请求时出错！' }
			}
		} else {
			console.error('ERROR', '检查邀请码可用性失败，参数不合法')
			return { success: false, isAvailableInvitationCode: false, message: '检查邀请码可用性失败，参数不合法' }
		}
	} catch (error) {
		console.error('ERROR', '检查邀请码可用性失败，未知错误', error)
		return { success: false, isAvailableInvitationCode: false, message: '检查邀请码可用性失败，未知错误' }
	}
}

/**
 * 获取用户注册时使用的邀请码
 * @param uuid 用户 UUID
 * @param token 用户 token
 * @returns 返回用户注册时使用的邀请码
 */
export const getUserInvitationCodeService = async (uuid: string, token: string): Promise<GetUserInvitationCodeResponseDto> => {
	try {
		if (await checkUserTokenByUUID(uuid, token)) {
			const { collectionName, schemaInstance } = UserInvitationCodeSchema
			type UserInvitationCode = InferSchemaType<typeof schemaInstance>

			// 查询条件：确保 assigneeUUID 字段等于传入的 uuid
			const InvitationCodeWhere: QueryType<UserInvitationCode> = {
				assigneeUUID: uuid,
			}

			const InvitationCodeSelect: SelectType<UserInvitationCode> = {
				invitationCode: 1,
			}

			try {
				const myInvitationCodeResult = await selectDataFromMongoDB<UserInvitationCode>(InvitationCodeWhere, InvitationCodeSelect, schemaInstance, collectionName)
				if (myInvitationCodeResult.success) {
					if (myInvitationCodeResult.result?.length <= 0) {
						return { success: true, message: '邀请码为空' }
					} else {
						// 提取并返回第一个匹配的邀请码
						const invitationCode = myInvitationCodeResult.result[0].invitationCode
						return { success: true, message: '获取邀请码成功', invitationCode }
					}
				} else {
					console.error('ERROR', '获取邀请码失败，请求失败', { uuid })
					return { success: false, message: '获取邀请码失败，请求失败！' }
				}
			} catch (error) {
				console.error('ERROR', '获取邀请码失败，请求时出错', { uuid, error })
				return { success: false, message: '获取邀请码失败，请求时出错！' }
			}
		} else {
			console.error('ERROR', '获取邀请码失败，非法用户！', { uuid })
			return { success: false, message: '获取邀请码失败，非法用户！' }
		}
	} catch (error) {
		console.error('ERROR', '获取邀请码失败，未知错误', error)
		return { success: false, message: '获取邀请码失败，未知错误' }
	}
}

/**
 * 请求发送修改邮箱的邮箱验证码
 * @param requestSendChangeEmailVerificationCodeRequest 请求发送修改邮箱的邮箱验证码的请求载荷
 * @param uid 用户 UID
 * @param token 用户 token
 * @returns 请求发送修改邮箱的邮箱验证码的请求响应
 */
export const requestSendChangeEmailVerificationCodeService = async (requestSendChangeEmailVerificationCodeRequest: RequestSendChangeEmailVerificationCodeRequestDto, uid: number, token: string): Promise<RequestSendChangeEmailVerificationCodeResponseDto> => {
	try {
		if (await checkUserToken(uid, token)) {
			if (checkRequestSendChangeEmailVerificationCodeRequest(requestSendChangeEmailVerificationCodeRequest)) {
				const { clientLanguage, newEmail } = requestSendChangeEmailVerificationCodeRequest
				try {
					if (newEmail) {
						const emailLowerCase = newEmail.toLowerCase()
						const nowTime = new Date().getTime()
						const todayStart = new Date()
						todayStart.setHours(0, 0, 0, 0)
						const { collectionName, schemaInstance } = UserChangeEmailVerificationCodeSchema
						type UserVerificationCode = InferSchemaType<typeof schemaInstance>
						const requestSendVerificationCodeWhere: QueryType<UserVerificationCode> = {
							emailLowerCase,
						}

						const requestSendVerificationCodeSelect: SelectType<UserVerificationCode> = {
							emailLowerCase: 1, // 用户邮箱
							attemptsTimes: 1,
							lastRequestDateTime: 1, // 用户上一次请求验证码的时间，用于防止滥用
						}

						// 启动事务
						const session = await mongoose.startSession()
						session.startTransaction()

						try {
							const requestSendVerificationCodeResult = await selectDataFromMongoDB<UserVerificationCode>(requestSendVerificationCodeWhere, requestSendVerificationCodeSelect, schemaInstance, collectionName, { session })
							if (requestSendVerificationCodeResult.success) {
								const lastRequestDateTime = requestSendVerificationCodeResult.result?.[0]?.lastRequestDateTime ?? 0
								const attemptsTimes = requestSendVerificationCodeResult.result?.[0]?.attemptsTimes ?? 0
								if (requestSendVerificationCodeResult.result.length === 0 || lastRequestDateTime + 55000 < nowTime) { // 前端 60 秒，后端 55 秒
									const lastRequestDate = new Date(lastRequestDateTime)
									if (requestSendVerificationCodeResult.result.length === 0 || todayStart > lastRequestDate || attemptsTimes < 10) { // ! 每天十次机会
										const verificationCode = generateSecureVerificationNumberCode(6) // 生成六位随机数验证码
										let newAttemptsTimes = attemptsTimes + 1
										if (todayStart > lastRequestDate) {
											newAttemptsTimes = 0
										}

										const requestSendVerificationCodeUpdate: UserVerificationCode = {
											emailLowerCase,
											verificationCode,
											overtimeAt: nowTime + 1800000, // 当前时间加上 1800000 毫秒（30 分钟）作为新的过期时间
											attemptsTimes: newAttemptsTimes,
											lastRequestDateTime: nowTime,
											editDateTime: nowTime,
										}
										const updateResult = await findOneAndUpdateData4MongoDB(requestSendVerificationCodeWhere, requestSendVerificationCodeUpdate, schemaInstance, collectionName, { session })
										if (updateResult.success) {
											// TODO: 使用多语言 email title and text
											try {
												const mailTitleCHS = 'KIRAKIRA 更改邮箱验证码'
												const mailTitleEN = 'KIRAKIRA Change Email Verification Code'
												const correctMailTitle = clientLanguage === 'zh-Hans-CN' ? mailTitleCHS : mailTitleEN

												// 请不要使用 “您”
												const mailHtmlCHS = `
														<p>你更改邮箱的验证码是：<strong>${verificationCode}</strong></p>
														<br>
														验证码 30 分钟内有效。请注意安全，不要向他人泄露你的验证码。
													`
												const mailHtmlEN = `
														<p>Your change email verification code is: <strong>${verificationCode}</strong></p>
														<br>
														Verification code is valid for 30 minutes. Please ensure do not disclose your verification code to others.
														<br>
														<br>
														To stop receiving notifications, please contact the KIRAKIRA support team.
													`
												const correctMailHTML = clientLanguage === 'zh-Hans-CN' ? mailHtmlCHS : mailHtmlEN
												const sendMailResult = await sendMail(newEmail, correctMailTitle, { html: correctMailHTML })
												if (sendMailResult.success) {
													await session.commitTransaction()
													session.endSession()
													return { success: true, isCoolingDown: false, message: '修改邮箱的验证码已发送至你注册时使用的邮箱，请注意查收，如未收到，请检查垃圾箱或联系 KIRAKIRA 客服。' }
												} else {
													if (session.inTransaction()) {
														await session.abortTransaction()
													}
													session.endSession()
													console.error('ERROR', '请求发送修改邮箱的验证码失败，邮件发送失败')
													return { success: false, isCoolingDown: true, message: '请求发送修改邮箱的验证码失败，邮件发送失败' }
												}
											} catch (error) {
												if (session.inTransaction()) {
													await session.abortTransaction()
												}
												session.endSession()
												console.error('ERROR', '请求发送修改邮箱的验证码失败，邮件发送时出错', error)
												return { success: false, isCoolingDown: true, message: '请求发送修改邮箱的验证码失败，邮件发送时出错' }
											}
										} else {
											if (session.inTransaction()) {
												await session.abortTransaction()
											}
											session.endSession()
											console.error('ERROR', '请求发送修改邮箱的验证码失败，更新或新增用户验证码失败')
											return { success: false, isCoolingDown: false, message: '请求发送修改邮箱的验证码失败，更新或新增用户验证码失败' }
										}
									} else {
										if (session.inTransaction()) {
											await session.abortTransaction()
										}
										session.endSession()
										console.warn('WARN', 'WARNING', '请求发送修改邮箱的验证码失败，已达本日重试次数上限，请稍后再试')
										return { success: true, isCoolingDown: true, message: '请求发送修改邮箱的验证码失败，已达本日重试次数上限，请稍后再试' }
									}
								} else {
									if (session.inTransaction()) {
										await session.abortTransaction()
									}
									session.endSession()
									console.warn('WARN', 'WARNING', '请求发送修改邮箱的验证码失败，未超过邮件超时时间，请稍后再试')
									return { success: true, isCoolingDown: true, message: '请求发送修改邮箱的验证码失败，未超过邮件超时时间，请稍后再试' }
								}
							} else {
								if (session.inTransaction()) {
									await session.abortTransaction()
								}
								session.endSession()
								console.error('ERROR', '请求发送修改邮箱的验证码失败，获取验证码失败')
								return { success: false, isCoolingDown: false, message: '请求发送修改邮箱的验证码失败，获取验证码失败' }
							}
						} catch (error) {
							if (session.inTransaction()) {
								await session.abortTransaction()
							}
							session.endSession()
							console.error('ERROR', '请求发送修改邮箱的验证码失败，检查超时时间时出错', error)
							return { success: false, isCoolingDown: false, message: '请求发送修改邮箱的验证码失败，检查超时时间时出错' }
						}
					} else {
						console.error('ERROR', '发送更新邮箱的验证码失败，获取用户旧邮箱失败', { uid })
						return { success: false, isCoolingDown: false, message: '发送更新邮箱的验证码失败，获取用户旧邮箱失败' }
					}
				} catch (error) {
					console.error('ERROR', '发送更新邮箱的验证码失败，获取用户旧邮箱时出错', { error, uid })
					return { success: false, isCoolingDown: false, message: '发送更新邮箱的验证码失败，获取用户旧邮箱时出错' }
				}
			} else {
				console.error('ERROR', '发送更新邮箱的验证码失败，参数不合法！', { uid })
				return { success: false, isCoolingDown: false, message: '发送更新邮箱的验证码失败，参数不合法！' }
			}
		} else {
			console.error('ERROR', '发送更新邮箱的验证码失败，非法用户！', { uid })
			return { success: false, isCoolingDown: false, message: '发送更新邮箱的验证码失败，非法用户！' }
		}
	} catch (error) {
		console.error('ERROR', '发送更新邮箱的验证码失败，未知错误', error)
		return { success: false, isCoolingDown: false, message: '发送更新邮箱的验证码失败，未知错误' }
	}
}

/**
 * 请求发送修改密码的邮箱验证码
 * @param requestSendChangePasswordVerificationCodeRequest 请求发送修改密码的邮箱验证码的请求载荷
 * @param uid 用户 UID
 * @param token 用户 token
 * @returns 请求发送修改密码的邮箱验证码的请求响应
 */
export const requestSendChangePasswordVerificationCodeService = async (requestSendChangePasswordVerificationCodeRequest: RequestSendChangePasswordVerificationCodeRequestDto, uid: number, token: string): Promise<RequestSendChangePasswordVerificationCodeResponseDto> => {
	try {
		if (await checkUserToken(uid, token)) {
			const UUID = await getUserUuid(uid) // DELETE ME 这是一个临时解决方法，Cookie 中应当存储 UUID
			if (!UUID) {
				console.error('ERROR', '请求发送修改密码的邮箱验证码失败，UUID 不存在', { uid })
				return { success: false, isCoolingDown: false, message: '请求发送修改密码的邮箱验证码失败，UUID 不存在' }
			}

			if (checkRequestSendChangePasswordVerificationCodeRequest(requestSendChangePasswordVerificationCodeRequest)) {
				const { clientLanguage } = requestSendChangePasswordVerificationCodeRequest
				try {
					const getSelfUserInfoRequest = {
						uid,
						token,
					}
					const selfUserInfoResult = await getSelfUserInfoService(getSelfUserInfoRequest)
					const email = selfUserInfoResult.result.email
					if (selfUserInfoResult.success && email) {
						const emailLowerCase = email.toLowerCase()
						const nowTime = new Date().getTime()
						const todayStart = new Date()
						todayStart.setHours(0, 0, 0, 0)
						const { collectionName, schemaInstance } = UserChangePasswordVerificationCodeSchema
						type UserChangePasswordVerificationCode = InferSchemaType<typeof schemaInstance>
						const requestSendVerificationCodeWhere: QueryType<UserChangePasswordVerificationCode> = {
							emailLowerCase,
						}

						const requestSendVerificationCodeSelect: SelectType<UserChangePasswordVerificationCode> = {
							emailLowerCase: 1, // 用户邮箱
							attemptsTimes: 1,
							lastRequestDateTime: 1, // 用户上一次请求验证码的时间，用于防止滥用
						}

						// 启动事务
						const session = await mongoose.startSession()
						session.startTransaction()

						try {
							const requestSendVerificationCodeResult = await selectDataFromMongoDB<UserChangePasswordVerificationCode>(requestSendVerificationCodeWhere, requestSendVerificationCodeSelect, schemaInstance, collectionName, { session })
							if (requestSendVerificationCodeResult.success) {
								const lastRequestDateTime = requestSendVerificationCodeResult.result?.[0]?.lastRequestDateTime ?? 0
								const attemptsTimes = requestSendVerificationCodeResult.result?.[0]?.attemptsTimes ?? 0
								if (requestSendVerificationCodeResult.result.length === 0 || lastRequestDateTime + 55000 < nowTime) { // 前端 60 秒，后端 55 秒
									const lastRequestDate = new Date(lastRequestDateTime)
									if (requestSendVerificationCodeResult.result.length === 0 || todayStart > lastRequestDate || attemptsTimes < 3) { // ! 每天三次机会
										const verificationCode = generateSecureVerificationNumberCode(6) // 生成六位随机数验证码
										let newAttemptsTimes = attemptsTimes + 1
										if (todayStart > lastRequestDate) {
											newAttemptsTimes = 0
										}

										const requestSendVerificationCodeUpdate: UserChangePasswordVerificationCode = {
											UUID,
											uid,
											emailLowerCase,
											verificationCode,
											overtimeAt: nowTime + 1800000, // 当前时间加上 1800000 毫秒（30 分钟）作为新的过期时间
											attemptsTimes: newAttemptsTimes,
											lastRequestDateTime: nowTime,
											editDateTime: nowTime,
										}
										const updateResult = await findOneAndUpdateData4MongoDB(requestSendVerificationCodeWhere, requestSendVerificationCodeUpdate, schemaInstance, collectionName, { session })
										if (updateResult.success) {
											// TODO: 使用多语言 email title and text
											try {
												const mailTitleCHS = 'KIRAKIRA 更改密码验证码'
												const mailTitleEN = 'KIRAKIRA Change Password Verification Code'
												const correctMailTitle = clientLanguage === 'zh-Hans-CN' ? mailTitleCHS : mailTitleEN

												// 请不要使用 “您”
												const mailHtmlCHS = `
														<p>你更改密码的验证码是：<strong>${verificationCode}</strong></p>
														<br>
														验证码 30 分钟内有效。请注意安全，不要向他人泄露你的验证码。
													`
												const mailHtmlEN = `
														<p>Your change password verification code is: <strong>${verificationCode}</strong></p>
														<br>
														Verification code is valid for 30 minutes. Please ensure do not disclose your verification code to others.
														<br>
														<br>
														To stop receiving notifications, please contact the KIRAKIRA support team.
													`
												const correctMailHTML = clientLanguage === 'zh-Hans-CN' ? mailHtmlCHS : mailHtmlEN
												const sendMailResult = await sendMail(email, correctMailTitle, { html: correctMailHTML })
												if (sendMailResult.success) {
													await session.commitTransaction()
													session.endSession()
													return { success: true, isCoolingDown: false, message: '修改密码的验证码已发送至你注册时使用的邮箱，请注意查收，如未收到，请检查垃圾箱或联系 KIRAKIRA 客服。' }
												} else {
													if (session.inTransaction()) {
														await session.abortTransaction()
													}
													session.endSession()
													console.error('ERROR', '请求发送修改密码的验证码失败，邮件发送失败')
													return { success: false, isCoolingDown: true, message: '请求发送修改密码的验证码失败，邮件发送失败' }
												}
											} catch (error) {
												if (session.inTransaction()) {
													await session.abortTransaction()
												}
												session.endSession()
												console.error('ERROR', '请求发送修改密码的验证码失败，邮件发送时出错', error)
												return { success: false, isCoolingDown: true, message: '请求发送修改密码的验证码失败，邮件发送时出错' }
											}
										} else {
											if (session.inTransaction()) {
												await session.abortTransaction()
											}
											session.endSession()
											console.error('ERROR', '请求发送修改密码的验证码失败，更新或新增用户验证码失败')
											return { success: false, isCoolingDown: false, message: '请求发送修改密码的验证码失败，更新或新增用户验证码失败' }
										}
									} else {
										if (session.inTransaction()) {
											await session.abortTransaction()
										}
										session.endSession()
										console.warn('WARN', 'WARNING', '请求发送修改密码的验证码失败，已达本日重试次数上限，请稍后再试')
										return { success: true, isCoolingDown: true, message: '请求发送修改密码的验证码失败，已达本日重试次数上限，请稍后再试' }
									}
								} else {
									if (session.inTransaction()) {
										await session.abortTransaction()
									}
									session.endSession()
									console.warn('WARN', 'WARNING', '请求发送修改密码的验证码失败，未超过邮件超时时间，请稍后再试')
									return { success: true, isCoolingDown: true, message: '请求发送修改密码的验证码失败，未超过邮件超时时间，请稍后再试' }
								}
							} else {
								if (session.inTransaction()) {
									await session.abortTransaction()
								}
								session.endSession()
								console.error('ERROR', '请求发送修改密码的验证码失败，获取验证码失败')
								return { success: false, isCoolingDown: false, message: '请求发送修改密码的验证码失败，获取验证码失败' }
							}
						} catch (error) {
							if (session.inTransaction()) {
								await session.abortTransaction()
							}
							session.endSession()
							console.error('ERROR', '请求发送修改邮箱的验证码失败，检查超时时间时出错', error)
							return { success: false, isCoolingDown: false, message: '请求发送修改邮箱的验证码失败，检查超时时间时出错' }
						}
					} else {
						console.error('ERROR', '发送更新邮箱的验证码失败，获取用户旧邮箱失败', { uid })
						return { success: false, isCoolingDown: false, message: '发送更新邮箱的验证码失败，获取用户旧邮箱失败' }
					}
				} catch (error) {
					console.error('ERROR', '发送更新邮箱的验证码失败，获取用户旧邮箱时出错', { error, uid })
					return { success: false, isCoolingDown: false, message: '发送更新邮箱的验证码失败，获取用户旧邮箱时出错' }
				}
			} else {
				console.error('ERROR', '发送更新邮箱的验证码失败，参数不合法！', { uid })
				return { success: false, isCoolingDown: false, message: '发送更新邮箱的验证码失败，参数不合法！' }
			}
		} else {
			console.error('ERROR', '发送更新邮箱的验证码失败，非法用户！', { uid })
			return { success: false, isCoolingDown: false, message: '发送更新邮箱的验证码失败，非法用户！' }
		}
	} catch (error) {
		console.error('ERROR', '发送更新邮箱的验证码失败，未知错误', error)
		return { success: false, isCoolingDown: false, message: '发送更新邮箱的验证码失败，未知错误' }
	}
}

/**
 * 更新密码
 * @param updateUserPasswordRequest 更新密码的请求载荷
 * @param uid 用户 UID
 * @param token 用户 token
 * @returns 更新密码的请求响应
 */
export const changePasswordService = async (updateUserPasswordRequest: UpdateUserPasswordRequestDto, uid: number, token: string): Promise<UpdateUserPasswordResponseDto> => {
	try {
		if (checkUpdateUserPasswordRequest(updateUserPasswordRequest)) {
			if (await checkUserToken(uid, token)) {
				const { oldPasswordHash, newPasswordHash, verificationCode } = updateUserPasswordRequest
				const now = new Date().getTime()

				const { collectionName: userChangePasswordVerificationCodeCollectionName, schemaInstance: userChangePasswordVerificationCodeInstance } = UserChangePasswordVerificationCodeSchema
				type UserChangePasswordVerificationCode = InferSchemaType<typeof userChangePasswordVerificationCodeInstance>

				const userChangePasswordVerificationCodeWhere: QueryType<UserChangePasswordVerificationCode> = {
					uid,
					verificationCode,
					overtimeAt: { $gte: now },
				}
				const userChangePasswordVerificationCodeSelect: SelectType<UserChangePasswordVerificationCode> = {
					emailLowerCase: 1, // 用户邮箱
				}

				// 启动事务
				const session = await mongoose.startSession()
				session.startTransaction()

				try {
					const verificationCodeResult = await selectDataFromMongoDB<UserChangePasswordVerificationCode>(userChangePasswordVerificationCodeWhere, userChangePasswordVerificationCodeSelect, userChangePasswordVerificationCodeInstance, userChangePasswordVerificationCodeCollectionName, { session })
					if (!verificationCodeResult.success || verificationCodeResult.result?.length !== 1) {
						if (session.inTransaction()) {
							await session.abortTransaction()
						}
						session.endSession()
						console.error('ERROR', '修改密码时出错，验证失败')
						return { success: false, message: '修改密码时出错，验证失败' }
					}
				} catch (error) {
					if (session.inTransaction()) {
						await session.abortTransaction()
					}
					session.endSession()
					console.error('ERROR', '修改密码时出错，请求验证失败')
					return { success: false, message: '修改密码时出错，请求验证失败' }
				}

				const { collectionName, schemaInstance } = UserAuthSchema
				type UserAuth = InferSchemaType<typeof schemaInstance>

				const changePasswordWhere: QueryType<UserAuth> = { uid }
				const changePasswordSelect: SelectType<UserAuth> = {
					email: 1,
					uid: 1,
					passwordHashHash: 1,
				}

				try {
					const userAuthResult = await selectDataFromMongoDB<UserAuth>(changePasswordWhere, changePasswordSelect, schemaInstance, collectionName, { session })
					if (userAuthResult?.result && userAuthResult.result?.length === 1) {
						const userAuthInfo = userAuthResult.result[0]
						const isCorrectPassword = comparePasswordSync(oldPasswordHash, userAuthInfo.passwordHashHash)
						if (isCorrectPassword) {
							const newPasswordHashHash = hashPasswordSync(newPasswordHash)
							if (newPasswordHashHash) {
								const changePasswordUpdate: UpdateType<UserAuth> = {
									passwordHashHash: newPasswordHashHash,
									editDateTime: now,
								}
								try {
									const updateResult = await findOneAndUpdateData4MongoDB(changePasswordWhere, changePasswordUpdate, schemaInstance, collectionName, { session })
									if (updateResult.success) {
										await session.commitTransaction()
										session.endSession()
										return { success: true, message: '密码已更新！' }
									} else {
										if (session.inTransaction()) {
											await session.abortTransaction()
										}
										session.endSession()
										console.error('ERROR', '修改密码失败，更新密码失败', { uid })
										return { success: false, message: '修改密码时出错，更新密码失败' }
									}
								} catch (error) {
									if (session.inTransaction()) {
										await session.abortTransaction()
									}
									session.endSession()
									console.error('ERROR', '修改密码时出错，更新密码时出错', { uid, error })
									return { success: false, message: '修改密码时出错，更新密码时出错' }
								}
							} else {
								if (session.inTransaction()) {
									await session.abortTransaction()
								}
								session.endSession()
								console.error('ERROR', '修改密码失败，未能散列新密码', { uid })
								return { success: false, message: '修改密码失败，未能散列新密码' }
							}
						} else {
							if (session.inTransaction()) {
								await session.abortTransaction()
							}
							session.endSession()
							console.error('ERROR', '修改密码失败，密码校验未通过', { uid })
							return { success: false, message: '修改密码失败，密码校验未通过' }
						}
					} else {
						if (session.inTransaction()) {
							await session.abortTransaction()
						}
						session.endSession()
						console.error('ERROR', '修改密码失败，密码校验结果为空或不为一！', { uid })
						return { success: false, message: '修改密码失败，密码校验结果不正确' }
					}
				} catch (error) {
					if (session.inTransaction()) {
						await session.abortTransaction()
					}
					session.endSession()
					console.error('ERROR', '修改密码时出错，密码校验时出错！', { uid, error })
					return { success: false, message: '修改密码时出错，密码校验时出错！' }
				}
			} else {
				console.error('ERROR', '修改密码失败，非法用户！', { uid })
				return { success: false, message: '修改密码失败，非法用户！' }
			}
		} else {
			console.error('ERROR', '修改密码失败，参数不合法！', { uid })
			return { success: false, message: '修改密码失败，参数不合法！' }
		}
	} catch (error) {
		console.error('ERROR', '修改密码时出错，未知错误', error)
		return { success: false, message: '修改密码时出错，未知错误' }
	}
}

/**
 * // TODO: 计划中删除
 * // DELETE ME 这是一个临时的解决方案，以后 Cookie 中直接存储 UUID
 * 根据 UID 验证某个用户是否是某个角色
 * @param uid 用户 ID, 为空时会导致校验失败
 * @param role 用户的角色
 * @returns 校验结果，如果用户是这个角色返回 true，否则返回 false
 */
export const checkUserRoleService = async (uid: number, role: string | string[]): Promise<boolean> => {
	try {
		if (uid !== undefined && uid !== null && role) {
			const { collectionName, schemaInstance } = UserAuthSchema
			type UserAuth = InferSchemaType<typeof schemaInstance>
			let userTokenWhere: QueryType<UserAuth> = {
				uid: -1,
			}
			if (typeof role === 'string') {
				userTokenWhere = {
					uid,
					role,
				}
			} else {
				userTokenWhere = {
					uid,
					role: { $in: role },
				}
			}
			const userTokenSelect: SelectType<UserAuth> = {
				uid: 1,
			}

			try {
				const checkUserRoleResult = await selectDataFromMongoDB(userTokenWhere, userTokenSelect, schemaInstance, collectionName)
				if (checkUserRoleResult && checkUserRoleResult.success) {
					if (checkUserRoleResult.result?.length === 1) {
						return true
					} else {
						console.error('ERROR', `验证用户角色时，用户信息长度不为 1，用户uid：【${uid}】`)
						return false
					}
				} else {
					console.error('ERROR', `验证用户角色时未查询到用户信息，用户uid：【${uid}】`)
					return false
				}
			} catch (error) {
				console.error('ERROR', `验证用户角色时出错，用户uid：【${uid}】，错误信息：`, error)
				return false
			}
		} else {
			console.error('ERROR', `验证用户角色失败！用户 uid 或 role 不存在，用户 UID：${uid}`)
			return false
		}
	} catch (error) {
		console.error('ERROR', `验证用户角色失败！用户 UID：${uid}`, error)
		return false
	}
}

/**
 * 验证某个用户是否是某个角色
 * @param UUID 用户 UUID, 为空时会导致校验失败
 * @param role 用户的角色
 * @returns 校验结果，如果用户是这个角色返回 true，否则返回 false
 */
export const checkUserRoleByUUIDService = async (UUID: string, role: string | string[]): Promise<boolean> => {
	try {
		if (UUID !== undefined && UUID !== null && role) {
			const { collectionName, schemaInstance } = UserAuthSchema
			type UserAuth = InferSchemaType<typeof schemaInstance>
			let userTokenWhere: QueryType<UserAuth> = {
				uid: -1,
			}
			if (typeof role === 'string') {
				userTokenWhere = {
					UUID,
					role,
				}
			} else {
				userTokenWhere = {
					UUID,
					role: { $in: role },
				}
			}
			const userTokenSelect: SelectType<UserAuth> = {
				uid: 1,
			}

			try {
				const checkUserRoleResult = await selectDataFromMongoDB(userTokenWhere, userTokenSelect, schemaInstance, collectionName)
				if (checkUserRoleResult && checkUserRoleResult.success) {
					if (checkUserRoleResult.result?.length === 1) {
						return true
					} else {
						console.error('ERROR', `验证用户角色时，用户信息长度不为 1，用户 UUID: ${UUID}`)
						return false
					}
				} else {
					console.error('ERROR', `验证用户角色时未查询到用户信息，用户 UUID:${UUID}`)
					return false
				}
			} catch (error) {
				console.error('ERROR', `验证用户角色时出错，用户 UUID:${UUID}，错误信息：`, error)
				return false
			}
		} else {
			console.error('ERROR', `验证用户角色失败！用户 UUID 或 role 不存在，用户 UUID: ${UUID}`)
			return false
		}
	} catch (error) {
		console.error('ERROR', `验证用户角色失败！用户 UUID: ${UUID}`, error)
		return false
	}
}

/**
 * 检查用户名是否可用
 * @param checkUsernameRequest 检查用户名是否可用的请求载荷
 * @returns 检查用户名是否可用的请求响应
 */
export const checkUsernameService = async (checkUsernameRequest: CheckUsernameRequestDto): Promise<CheckUsernameResponseDto> => {
	try {
		if (checkCheckUsernameRequest(checkUsernameRequest)) {
			const { username } = checkUsernameRequest
			const { collectionName, schemaInstance } = UserInfoSchema
			type UserInfo = InferSchemaType<typeof schemaInstance>
			const checkUsernameWhere: QueryType<UserInfo> = {
				username: { $regex: new RegExp(`\\b${username}\\b`, 'iu') },
			}
			const checkUsernameSelete: SelectType<UserInfo> = {
				uid: 1,
			}
			try {
				const checkUsername = await selectDataFromMongoDB(checkUsernameWhere, checkUsernameSelete, schemaInstance, collectionName)
				if (checkUsername.success) {
					if (checkUsername.result?.length === 0) {
						return { success: true, message: '用户名可用', isAvailableUsername: true }
					} else {
						return { success: true, message: '用户名重复', isAvailableUsername: false }
					}
				} else {
					console.error('ERROR', '检查用户名失败，请求用户数据失败')
					return { success: false, message: '检查用户名失败，请求用户数据失败', isAvailableUsername: false }
				}
			} catch (error) {
				console.error('ERROR', '检查用户名时出错，请求用户数据出错', error)
				return { success: false, message: '检查用户名时出错，请求用户数据出错', isAvailableUsername: false }
			}
		} else {
			console.error('ERROR', '检查用户名失败，参数不合法')
			return { success: false, message: '检查用户名失败，参数不合法', isAvailableUsername: false }
		}
	} catch (error) {
		console.error('ERROR', '检查用户名时出错，未知错误', error)
		return { success: false, message: '检查用户名时出错，未知错误', isAvailableUsername: false }
	}
}

/**
 * 根据 UID 封禁一个用户
 * @param blockUserByUIDRequest 封禁用户的请求载荷
 * @param adminUid 管理员的 UID
 * @param adminToken 管理员的 Token
 * @returns 封禁用户的请求响应
 */
export const blockUserByUIDService = async (blockUserByUIDRequest: BlockUserByUIDRequestDto, adminUid: number, adminToken: string): Promise<BlockUserByUIDResponseDto> => {
	try {
		if (checkBlockUserByUIDRequest(blockUserByUIDRequest)) {
			if (await checkUserToken(adminUid, adminToken)) {
				const isAdmin = await checkUserRoleService(adminUid, 'admin')
				if (isAdmin) {
					const { criminalUid } = blockUserByUIDRequest
					const { collectionName, schemaInstance } = UserAuthSchema
					type UserAuth = InferSchemaType<typeof schemaInstance>

					const blockUserByUIDWhere: QueryType<UserAuth> = {
						uid: criminalUid,
						role: 'user',
					}

					const blockUserByUIDUpdate: UpdateType<UserAuth> = {
						role: 'blocked',
					}
					try {
						const updateResult = await findOneAndUpdateData4MongoDB<UserAuth>(blockUserByUIDWhere, blockUserByUIDUpdate, schemaInstance, collectionName, undefined, false)
						if (updateResult.success && updateResult.result) {
							return { success: true, message: '封禁用户成功' }
						} else {
							console.error('ERROR', '封禁用户失败，返回结果失败或结果为空')
							return { success: false, message: '封禁用户失败，返回结果失败或结果为空' }
						}
					} catch (error) {
						console.error('ERROR', '封禁用户时出错，更新数据时出错', error)
						return { success: false, message: '封禁用户时出错，更新数据出错' }
					}
				} else {
					console.error('ERROR', '封禁用户失败，用户权限不足')
					return { success: false, message: '封禁用户失败，用户权限不足' }
				}
			} else {
				console.error('ERROR', '封禁用户失败，用户校验未通过')
				return { success: false, message: '封禁用户失败，用户校验未通过' }
			}
		} else {
			console.error('ERROR', '封禁用户失败，参数不合法')
			return { success: false, message: '封禁用户失败，参数不合法' }
		}
	} catch (error) {
		console.error('ERROR', '封禁用户时出错，未知错误', error)
		return { success: false, message: '封禁用户时出错，未知错误' }
	}
}

/**
 * 根据 UID 重新激活一个用户
 * @param reactivateUserByUIDRequest 重新激活用户的请求载荷
 * @param adminUid 管理员的 UID
 * @param adminToken 管理员的 Token
 * @returns 重新激活用户的请求响应
 */
export const reactivateUserByUIDService = async (reactivateUserByUIDRequest: ReactivateUserByUIDRequestDto, adminUid: number, adminToken: string): Promise<ReactivateUserByUIDResponseDto> => {
	try {
		if (checkReactivateUserByUIDRequest(reactivateUserByUIDRequest)) {
			if (await checkUserToken(adminUid, adminToken)) {
				const isAdmin = await checkUserRoleService(adminUid, 'admin')
				if (isAdmin) {
					const { uid } = reactivateUserByUIDRequest
					const { collectionName, schemaInstance } = UserAuthSchema
					type UserAuth = InferSchemaType<typeof schemaInstance>

					const reactivateUserByUIDWhere: QueryType<UserAuth> = {
						uid,
						role: 'blocked',
					}

					const reactivateUserByUIDUpdate: UpdateType<UserAuth> = {
						role: 'user',
					}
					try {
						const updateResult = await findOneAndUpdateData4MongoDB<UserAuth>(reactivateUserByUIDWhere, reactivateUserByUIDUpdate, schemaInstance, collectionName, undefined, false)
						if (updateResult.success && updateResult.result) {
							return { success: true, message: '重新激活用户成功' }
						} else {
							console.error('ERROR', '重新激活用户失败，返回结果失败或结果为空')
							return { success: false, message: '重新激活用户失败，返回结果失败或结果为空' }
						}
					} catch (error) {
						console.error('ERROR', '重新激活用户时出错，更新数据时出错', error)
						return { success: false, message: '重新激活用户时出错，更新数据出错' }
					}
				} else {
					console.error('ERROR', '重新激活用户失败，用户权限不足')
					return { success: false, message: '重新激活用户失败，用户权限不足' }
				}
			} else {
				console.error('ERROR', '重新激活用户失败，用户校验未通过')
				return { success: false, message: '重新激活用户失败，用户校验未通过' }
			}
		} else {
			console.error('ERROR', '重新激活用户失败，参数不合法')
			return { success: false, message: '重新激活用户失败，参数不合法' }
		}
	} catch (error) {
		console.error('ERROR', '重新激活用户时出错，未知错误', error)
		return { success: false, message: '重新激活用户时出错，未知错误' }
	}
}


/**
 * 获取所有被封禁用户的信息
 * @param adminUid 管理员的 UID
 * @param adminToken 管理员的 Token
 * @returns 获取所有被封禁用户的信息的请求响应
 */
export const getBlockedUserService = async (adminUid: number, adminToken: string): Promise<GetBlockedUserResponseDto> => {
	try {
		if (await checkUserToken(adminUid, adminToken)) {
			const isAdmin = await checkUserRoleService(adminUid, 'admin')
			if (isAdmin) {
				const { collectionName: userAuthCollectionName, schemaInstance: userAuthSchemaInstance } = UserAuthSchema

				// TODO: 下方这个 Aggregate 只适用于被封禁用户的搜索
				const blockedUserAggregateProps: PipelineStage[] = [
					{
						$match: {
							role: 'blocked',
						},
					},
					{
						$lookup: {
							from: 'user-infos', // WARN: 别忘了加复数
							localField: 'uid',
							foreignField: 'uid',
							as: 'user_info_data',
						},
					},
					{
						$unwind: {
							path: '$user_info_data',
							preserveNullAndEmptyArrays: true, // 保留空数组和null值
						},
					},
					{
						$project: {
							uid: 1,
							UUID: 1,
							userCreateDateTime: 1, // 用户创建日期
							role: 1, // 用户的角色
							username: '$user_info_data.username', // 用户名
							userNickname: '$user_info_data.userNickname', // 用户昵称
							avatar: '$user_info_data.avatar', // 用户头像
							userBannerImage: '$user_info_data.userBannerImage', // 用户的背景图
							signature: '$user_info_data.signature', // 用户的个性签名
							gender: '$user_info_data.gender', // 用户的性别
						},
					},
				]

				try {
					const userResult = await selectDataByAggregateFromMongoDB(userAuthSchemaInstance, userAuthCollectionName, blockedUserAggregateProps)
					if (userResult && userResult.success) {
						const userInfo = userResult?.result
						if (userInfo?.length > 0) {
							return { success: true, message: '获取封禁用户信息成功',
								result: userInfo,
							}
						} else {
							return { success: true, message: '没有被封禁用户', result: [] }
						}
					} else {
						console.error('ERROR', '获取所有被封禁用户的信息失败，获取到的结果为空')
						return { success: false, message: '获取所有被封禁用户的信息失败，结果为空' }
					}
				} catch (error) {
					console.error('ERROR', '获取所有被封禁用户的信息失败，查询数据时出错：0', error)
					return { success: false, message: '获取所有被封禁用户的信息失败，查询数据时出错' }
				}
			} else {
				console.error('ERROR', '获取所有被封禁用户的信息失败，用户权限不足')
				return { success: false, message: '获取所有被封禁用户的信息失败，用户权限不足' }
			}
		} else {
			console.error('ERROR', '获取所有被封禁用户的信息失败，用户校验失败')
			return { success: false, message: '获取所有被封禁用户的信息失败，用户校验失败' }
		}
	} catch (error) {
		console.error('ERROR', '获取所有被封禁用户的信息时出错，未知错误：', error)
		return { success: false, message: '获取所有被封禁用户的信息时出错，未知错误' }
	}
}

/**
 * 管理员获取用户信息
 * @param adminGetUserInfoServiceRequest 管理员获取用户信息的请求载荷
 * @param adminUUID 管理员的 UUID
 * @param adminToken 管理员的 Token
 * @returns 管理员获取用户信息的请求响应
 */
export const adminGetUserInfoService = async (adminGetUserInfoRequest: AdminGetUserInfoRequestDto, adminUUID: string, adminToken: string): Promise<AdminGetUserInfoResponseDto> => {
	try {
		if (!checkAdminGetUserInfoRequest(adminGetUserInfoRequest)) {
			console.error('ERROR', '管理员获取用户信息失败，请求参数不合法')
			return { success: false, message: '管理员获取用户信息失败，请求参数不合法', totalCount: 0 }
		}

		if (!await checkUserTokenByUUID(adminUUID, adminToken)) {
			console.error('ERROR', '管理员获取用户信息失败，用户校验未通过')
			return { success: false, message: '管理员获取用户信息失败，用户校验未通过', totalCount: 0 }
		}

		if (!await checkUserRoleByUUIDService(adminUUID, 'admin')) {
			console.error('ERROR', '管理员获取用户信息失败，用户权限不足')
			return { success: false, message: '管理员获取用户信息失败，用户权限不足', totalCount: 0 }
		}

		let pageSize = undefined
		let skip = 0
		if (adminGetUserInfoRequest.pagination && adminGetUserInfoRequest.pagination.page > 0 && adminGetUserInfoRequest.pagination.pageSize > 0) {
			skip = (adminGetUserInfoRequest.pagination.page - 1) * adminGetUserInfoRequest.pagination.pageSize
			pageSize = adminGetUserInfoRequest.pagination.pageSize
		}

		const { collectionName: userAuthCollectionName, schemaInstance: userAuthSchemaInstance } = UserAuthSchema
		const adminGetUserInfoCountPipeline: PipelineStage[] = [
			{
				$lookup: {
					from: 'user-infos', // WARN: 别忘了加复数
					localField: 'UUID',
					foreignField: 'UUID',
					as: 'user_info_data',
				},
			},
			{
				$unwind: {
					path: '$user_info_data',
					preserveNullAndEmptyArrays: true, // 保留空数组和null值
				},
			},
		]

		const adminGetUserInfoPipeline: PipelineStage[] = [
			{
				$lookup: {
					from: 'user-infos', // WARN: 别忘了加复数
					localField: 'UUID',
					foreignField: 'UUID',
					as: 'user_info_data',
				},
			},
			{
				$unwind: {
					path: '$user_info_data',
					preserveNullAndEmptyArrays: true, // 保留空数组和null值
				},
			},
			{ $sort: { 'user_info_data.editDateTime': -1 } }, // 按最后编辑时间降序排序
			{ $skip: skip }, // 跳过指定数量的文档
			{ $limit: pageSize }, // 限制返回的文档数量
		]

		if (adminGetUserInfoRequest.isOnlyShowUserInfoUpdatedAfterReview) {
			const userInfoFilter = {
				$match: {
					'user_info_data.isUpdatedAfterReview': true,
				},
			}
			adminGetUserInfoCountPipeline.push(userInfoFilter)
			adminGetUserInfoPipeline.push(userInfoFilter)
		}

		const projectStep = {
			$project: {
				uid: 1,
				UUID: 1,
				userCreateDateTime: 1, // 用户创建日期
				role: 1, // 用户的角色
				username: '$user_info_data.username', // 用户名
				userNickname: '$user_info_data.userNickname', // 用户昵称
				avatar: '$user_info_data.avatar', // 用户头像
				userBannerImage: '$user_info_data.userBannerImage', // 用户的背景图
				signature: '$user_info_data.signature', // 用户的个性签名
				gender: '$user_info_data.gender', // 用户的性别
				totalCount: 1, // 总文档数
			},
		}
		adminGetUserInfoPipeline.push(projectStep)

		const countStep = {
			$count: 'totalCount', // 统计总文档数
		}
		adminGetUserInfoCountPipeline.push(countStep)

		try {
			const userCountResult = await selectDataByAggregateFromMongoDB(userAuthSchemaInstance, userAuthCollectionName, adminGetUserInfoCountPipeline)
			const userResult = await selectDataByAggregateFromMongoDB(userAuthSchemaInstance, userAuthCollectionName, adminGetUserInfoPipeline)
			if (!userResult.success) {
				console.error('ERROR', '管理员获取用户信息失败，查询数据失败')
				return { success: false, message: '管理员获取用户信息失败，查询数据失败', totalCount: 0 }
			}

			return { success: true, message: '管理员获取用户信息成功', result: userResult.result, totalCount: userCountResult.result?.[0]?.totalCount ?? 0 }
		} catch (error) {
			console.error('ERROR', '管理员获取用户信息时出错，查询数据时出错：', error)
			return { success: false, message: '管理员获取用户信息时出错，查询数据时出错', totalCount: 0 }
		}
	} catch (error) {
		console.error('ERROR', '管理员获取用户信息时出错，未知错误：', error)
		return { success: false, message: '管理员获取用户信息时出错，未知错误', totalCount: 0 }
	}
}

/**
 * 管理员通过用户信息审核
 * @param approveUserInfoRequest 管理员通过用户信息审核的请求载荷
 * @param adminUUID 管理员的 UUID
 * @param adminToken 管理员的 Token
 * @returns 管理员通过用户信息审核的请求响应
 */
export const approveUserInfoService = async (approveUserInfoRequest: ApproveUserInfoRequestDto, adminUUID: string, adminToken: string): Promise<ApproveUserInfoResponseDto> => {
	try {
		if (!checkApproveUserInfoRequest(approveUserInfoRequest)) {
			console.error('ERROR', '管理员通过用户信息审核失败，参数不合法')
			return { success: false, message: '管理员通过用户信息审核失败，参数不合法' }
		}

		if (!await checkUserTokenByUUID(adminUUID, adminToken)) {
			console.error('ERROR', '管理员通过用户信息审核失败，用户校验未通过')
			return { success: false, message: '管理员通过用户信息审核失败，用户校验未通过' }
		}

		if (!await checkUserRoleByUUIDService(adminUUID, 'admin')) {
			console.error('ERROR', '管理员通过用户信息审核失败，用户权限不足')
			return { success: false, message: '管理员通过用户信息审核失败，用户权限不足' }
		}

		const UUID = approveUserInfoRequest.UUID
		const { collectionName, schemaInstance } = UserInfoSchema
		type UserInfo = InferSchemaType<typeof schemaInstance>

		const approveUserInfoWhere: QueryType<UserInfo> = {
			UUID,
		}
		const approveUserInfoUpdate: UpdateType<UserInfo> = {
			isUpdatedAfterReview: false,
			editDateTime: new Date().getTime(),
		}
		try {
			const updateResult = await findOneAndUpdateData4MongoDB(approveUserInfoWhere, approveUserInfoUpdate, schemaInstance, collectionName)
			if (!updateResult.success) {
				console.error('ERROR', '管理员通过用户信息审核失败，向数据库更新数据失败')
				return { success: false, message: '管理员通过用户信息审核失败，向数据库更新数据失败' }
			}

			return { success: true, message: '管理员通过用户信息审核成功' }
		} catch (error) {
			console.error('ERROR', '管理员通过用户信息审核时出错，向数据库更新数据时出错：', error)
			return { success: false, message: '管理员通过用户信息审核时出错，向数据库更新数据时出错' }
		}
	} catch (error) {
		console.error('ERROR', '管理员通过用户信息审核时出错，未知错误：', error)
		return { success: false, message: '管理员通过用户信息审核时出错，未知错误' }
	}
}

/**
 * 管理员清空某个用户的信息
 * @param approveUserInfoRequest 管理员清空某个用户的信息的请求载荷
 * @param adminUUID 管理员的 UUID
 * @param adminToken 管理员的 Token
 * @returns 管理员清空某个用户的信息请求响应
 */
export const adminClearUserInfoService = async (adminClearUserInfoRequest: AdminClearUserInfoRequestDto, adminUUID: string, adminToken: string): Promise<AdminClearUserInfoResponseDto> => {
	try {
		if (!checkAdminClearUserInfoRequest(adminClearUserInfoRequest)) {
			console.error('ERROR', '管理员清空某个用户的信息失败，参数不合法')
			return { success: false, message: '管理员清空某个用户的信息失败，参数不合法' }
		}

		if (!await checkUserTokenByUUID(adminUUID, adminToken)) {
			console.error('ERROR', '管理员清空某个用户的信息失败，用户校验未通过')
			return { success: false, message: '管理员清空某个用户的信息失败，用户校验未通过' }
		}

		if (!await checkUserRoleByUUIDService(adminUUID, 'admin')) {
			console.error('ERROR', '管理员清空某个用户的信息失败，用户权限不足')
			return { success: false, message: '管理员清空某个用户的信息失败，用户权限不足' }
		}

		const uid = adminClearUserInfoRequest.uid
		const UUID = await getUserUuid(uid)
		if (!UUID) {
			console.error('ERROR', '管理员清空某个用户的信息失败，UUID 不存在', { uid })
			return { success: false, message: '管理员清空某个用户的信息失败，UUID 不存在' }
		}

		const { collectionName, schemaInstance } = UserInfoSchema
		type UserInfo = InferSchemaType<typeof schemaInstance>

		const adminClearUserInfoWhere: QueryType<UserInfo> = {
			uid, // TODO: 也许可以删掉
			UUID,
		}
		const adminClearUserInfoUpdate: UpdateType<UserInfo> = {
			username: `${UUID}`,
			userNickname: '[cleaned]',
			avatar: '',
			userBannerImage: '',
			signature: '',
			gender: '',
			label: [] as UserInfo['label'], // TODO: Mongoose issue: #12420
			userBirthday: -1,
			userProfileMarkdown: '',
			userLinkAccounts: [] as UserInfo['userLinkAccounts'], // TODO: Mongoose issue: #12420
			userWebsite: { websiteName: '', websiteUrl: '' },
			isUpdatedAfterReview: false, // 清除信息的直接设为 false
			editDateTime: new Date().getTime(),
		}
		try {
			const updateResult = await findOneAndUpdateData4MongoDB(adminClearUserInfoWhere, adminClearUserInfoUpdate, schemaInstance, collectionName)
			if (!updateResult.success) {
				console.error('ERROR', '管理员清空某个用户的信息失败，向数据库更新数据失败')
				return { success: false, message: '管理员清空某个用户的信息失败，向数据库更新数据失败' }
			}

			return { success: true, message: '管理员清空某个用户的信息成功' }
		} catch (error) {
			console.error('ERROR', '管理员清空某个用户的信息时出错，向数据库更新数据时出错：', error)
			return { success: false, message: '管理员清空某个用户的信息时出错，向数据库更新数据时出错' }
		}
	} catch (error) {
		console.error('ERROR', '管理员清空某个用户的信息时出错，未知错误：', error)
		return { success: false, message: '管理员清空某个用户的信息时出错，未知错误' }
	}
}

/**
 * 根据 UID 获取 UUID
 * // DELETE ME 这是一个临时的解决方案，以后 Cookie 中直接存储 UUID
 * @param uid 用户 UID
 * @returns UUID
 */
export const getUserUuid = async (uid: number): Promise<string | void> => {
	try {
		if (uid === undefined || uid === null || uid <= 0) {
			console.error('ERROR', '通过 UID 获取 UUID 失败，UID 不合法')
			return
		}
		const { collectionName: userAuthCollectionName, schemaInstance: userAuthSchemaSchemaInstance } = UserAuthSchema
		type UserAuth = InferSchemaType<typeof userAuthSchemaSchemaInstance>

		const getUuidWhere: QueryType<UserAuth> = {
			uid,
		}

		const getUuidSelect: SelectType<UserAuth> = {
			UUID: 1,
		}

		const getUuidResult = await selectDataFromMongoDB(getUuidWhere, getUuidSelect, userAuthSchemaSchemaInstance, userAuthCollectionName)
		if (getUuidResult.success && getUuidResult.result?.length === 1) {
			return getUuidResult.result[0].UUID
		} else {
			console.error('ERROR', '通过 UID 获取 UUID 失败，UUID 不存在或结果长度不为 1')
		}
	} catch (error) {
		console.error('ERROR', '通过 UID 获取 UUID 时出错：', error)
		return
	}
}

/**
 * 检查用户 Token，检查 Token 和用户 uid 是否吻合，判断用户是否已注册
 * // DELETE ME 这是一个临时的解决方案，以后 Cookie 中直接存储 UUID
 * @param uid 用户 ID
 * @param token 用户 Token
 * @returns boolean 如果验证通过则为 true，不通过为 false
 */
const checkUserToken = async (uid: number, token: string): Promise<boolean> => {
	try {
		if (uid !== null && !Number.isNaN(uid) && uid !== undefined && token) {
			const { collectionName, schemaInstance } = UserAuthSchema
			type UserAuth = InferSchemaType<typeof schemaInstance>
			const userTokenWhere: QueryType<UserAuth> = {
				uid,
				token,
			}
			const userTokenSelect: SelectType<UserAuth> = {
				uid: 1,
			}
			try {
				const userInfo = await selectDataFromMongoDB(userTokenWhere, userTokenSelect, schemaInstance, collectionName)
				if (userInfo && userInfo.success) {
					if (userInfo.result?.length === 1) {
						return true
					} else {
						console.error('ERROR', `查询用户 Token 时，用户信息长度不为 1，用户uid：【${uid}】`)
						return false
					}
				} else {
					console.error('ERROR', `查询用户 Token 时未查询到用户信息，用户uid：【${uid}】，错误描述：${userInfo.message}，错误信息：${userInfo.error}`)
					return false
				}
			} catch (error) {
				console.error('ERROR', `查询用户 Token 时出错，用户uid：【${uid}】，错误信息：`, error)
				return false
			}
		} else {
			console.error('ERROR', `查询用户 Token 时出错，必要的参数 uid 或 token为空：【${uid}】`)
			return false
		}
	} catch (error) {
		console.error('ERROR', '查询用户 Token 时出错，未知错误：', error)
		return false
	}
}


/**
 * 检查用户 Token，检查 Token 和用户 uuid 是否吻合，判断用户是否已注册
 * @param UUID 用户 UUID
 * @param token 用户 Token
 * @returns boolean 如果验证通过则为 true，不通过为 false
 */
const checkUserTokenByUUID = async (UUID: string, token: string): Promise<boolean> => {
	try {
		if (UUID !== null && !Number.isNaN(UUID) && UUID !== undefined && token) {
			const { collectionName, schemaInstance } = UserAuthSchema
			type UserAuth = InferSchemaType<typeof schemaInstance>
			const userTokenWhere: QueryType<UserAuth> = {
				UUID,
				token,
			}
			const userTokenSelect: SelectType<UserAuth> = {
				uid: 1,
			}
			try {
				const userInfo = await selectDataFromMongoDB(userTokenWhere, userTokenSelect, schemaInstance, collectionName)
				if (userInfo && userInfo.success) {
					if (userInfo.result?.length === 1) {
						return true
					} else {
						console.error('ERROR', `查询用户 Token 时，用户信息长度不为 1，用户 UUID: ${UUID}`)
						return false
					}
				} else {
					console.error('ERROR', `查询用户 Token 时未查询到用户信息，用户 UUID: ${UUID}，错误描述：${userInfo.message}，错误信息：${userInfo.error}`)
					return false
				}
			} catch (error) {
				console.error('ERROR', `查询用户 Token 时出错，用户 UUID: ${UUID}，错误信息：`, error)
				return false
			}
		} else {
			console.error('ERROR', `查询用户 Token 时出错，必要的参数 uid 或 token为空 UUID: ${UUID}`)
			return false
		}
	} catch (error) {
		console.error('ERROR', '查询用户 Token 时出错，未知错误：', error)
		return false
	}
}

/** 通过恢复码删除用户 2FA 的参数 */
type DeleteTotpAuthenticatorByRecoveryCodeParametersDto = {
	/** 用户邮箱 */
	email: string,
	/** 恢复码 */
	recoveryCodeHash: string,
	/** 事务 */
	session?: mongoose.ClientSession,
}

/** 通过恢复码删除用户 2FA 的结果 */
type DeleteTotpAuthenticatorByRecoveryCodeResultDto = {} & DeleteTotpAuthenticatorByTotpVerificationCodeResponseDto

/**
 * 通过恢复码删除用户 2FA，只能在登录时使用
 * @param deleteTotpAuthenticatorByRecoveryCodeData 通过恢复码删除用户 2FA 的参数
 * @returns 通过恢复码删除用户 2FA 的结果
 */
const deleteTotpAuthenticatorByRecoveryCode = async (deleteTotpAuthenticatorByRecoveryCodeData: DeleteTotpAuthenticatorByRecoveryCodeParametersDto): Promise<DeleteTotpAuthenticatorByRecoveryCodeResultDto> => {
	try {
		if (!checkDeleteTotpAuthenticatorByRecoveryCodeData(deleteTotpAuthenticatorByRecoveryCodeData)) {
			console.error('ERROR', '通过恢复码删除用户 2FA 失败，参数不合法')
			return { success: false, message: '通过恢复码删除用户 2FA 失败，参数不合法' }
		}

		const { email, recoveryCodeHash, session } = deleteTotpAuthenticatorByRecoveryCodeData
		const emailLowerCase = email.toLowerCase()

		const { collectionName: userAuthCollectionName, schemaInstance: userAuthSchemaInstance } = UserAuthSchema
		type UserAuth = InferSchemaType<typeof userAuthSchemaInstance>
		const userAuthWhere: QueryType<UserAuth> = { emailLowerCase: emailLowerCase }
		const userAuthSelect: SelectType<UserAuth> = { UUID: 1 }
		const userInfo = await selectDataFromMongoDB<UserAuth>(userAuthWhere, userAuthSelect, userAuthSchemaInstance, userAuthCollectionName, { session })

		const uuid = userInfo?.result?.[0]?.UUID
		if (!uuid) {
			console.error('ERROR', '通过恢复码删除用户 2FA 失败，无法获取用户信息', { emailLowerCase })
			return { success: false, message: '通过恢复码删除用户 2FA 失败，无法获取用户信息' }
		}

		const { collectionName: userTotpAuthenticatorCollectionName, schemaInstance: userTotpAuthenticatorSchemaInstance } = UserTotpAuthenticatorSchema
		type UserTotpAuthenticator = InferSchemaType<typeof userTotpAuthenticatorSchemaInstance>
		const userTotpAuthenticatorWhere: QueryType<UserTotpAuthenticator> = { UUID: uuid, recoveryCodeHash }
		const deleteResult = await deleteDataFromMongoDB<UserTotpAuthenticator>(userTotpAuthenticatorWhere, userTotpAuthenticatorSchemaInstance, userTotpAuthenticatorCollectionName, { session })

		if (!deleteResult.success) {
			console.error('ERROR', '通过恢复码删除用户 2FA 失败，删除失败', { emailLowerCase })
			return { success: false, message: '通过恢复码删除用户 2FA 失败，删除失败' }
		}

		const resetResult = await resetUser2FATypeByUUID(uuid, session)

		if (!resetResult) {
			console.error('ERROR', '通过恢复码删除用户 2FA 失败，重置用户 2FA 数据失败', { emailLowerCase })
			return { success: false, message: '通过恢复码删除用户 2FA 失败，重置用户 2FA 数据失败' }
		}

		return { success: true, message: '用户的身份验证器已删除' }
	} catch (error) {
		console.error('ERROR', '通过恢复码删除用户 2FA失败', error)
		return { success: false, message: '通过恢复码删除用户 2FA 失败，发生未知错误' }
	}
}

/**
 * 已登录用户通过密码和 TOTP 验证码删除身份验证器
 * @param deleteTotpAuthenticatorByTotpVerificationCodeRequest 登录用户通过密码和 TOTP 验证码删除身份验证器的请求载荷
 * @param uuid 用户的 UUID
 * @param token 用户的 token
 * @returns 删除操作的结果
 */
export const deleteTotpAuthenticatorByTotpVerificationCodeService = async (deleteTotpAuthenticatorByTotpVerificationCodeRequest: DeleteTotpAuthenticatorByTotpVerificationCodeRequestDto, uuid: string, token: string): Promise<DeleteTotpAuthenticatorByTotpVerificationCodeResponseDto> => {
	try {
		if (!checkDeleteTotpAuthenticatorByTotpVerificationCodeRequest(deleteTotpAuthenticatorByTotpVerificationCodeRequest)) {
			console.error('ERROR', '已登录用户通过密码和 TOTP 验证码删除身份验证器失败，参数不合法')
			return { success: false, message: '已登录用户通过密码和 TOTP 验证码删除身份验证器验证器失败，参数不合法' }
		}

		if (!await checkUserTokenByUUID(uuid, token)) {
			console.error('ERROR', '已登录用户通过密码和 TOTP 验证码删除身份验证器失败，用户校验未通过')
			return { success: false, message: '已登录用户通过密码和 TOTP 验证码删除身份验证器验证器失败，用户校验未通过' }
		}

		const session = await mongoose.startSession()
		session.startTransaction()

		const now = new Date().getTime()
		const { clientOtp, passwordHash } = deleteTotpAuthenticatorByTotpVerificationCodeRequest
		const maxAttempts	 = 5
		const lockTime = 60 * 60 * 1000

		const { collectionName: userAuthCollectionName, schemaInstance: userAuthSchemaInstance } = UserAuthSchema
		type UserAuth = InferSchemaType<typeof userAuthSchemaInstance>

		const userLoginWhere: QueryType<UserAuth> = { UUID: uuid }
		const userLoginSelect: SelectType<UserAuth> = {
			passwordHashHash: 1,
		}

		const userAuthResult = await selectDataFromMongoDB<UserAuth>(userLoginWhere, userLoginSelect, userAuthSchemaInstance, userAuthCollectionName, { session })
		const passwordHashHash = userAuthResult.result?.[0]?.passwordHashHash
		if (!userAuthResult?.result || userAuthResult.result?.length !== 1) {
			console.error('ERROR', `已登录用户通过密码和 TOTP 验证码删除身份验证器失败，无法查询到用户安全信息`)
			return { success: false, message: '已登录用户通过密码和 TOTP 验证码删除身份验证器失败，无法查询到用户安全信息' }
		}

		const isCorrectPassword = comparePasswordSync(passwordHash, passwordHashHash)
		if (!isCorrectPassword) {
			console.error('ERROR', `已登录用户通过密码和 TOTP 验证码删除身份验证器失败，无法查询到用户安全信息`)
			return { success: false, message: '已登录用户通过密码和 TOTP 验证码删除身份验证器失败，用户密码不正确' }
		}

		const { collectionName: userTotpAuthenticatorCollectionName, schemaInstance: userTotpAuthenticatorSchemaInstance } = UserTotpAuthenticatorSchema
		type UserTotpAuthenticator = InferSchemaType<typeof userTotpAuthenticatorSchemaInstance>
		const deleteTotpAuthenticatorByTotpVerificationCodeWhere: QueryType<UserTotpAuthenticator> = {
			UUID: uuid,
			enabled: true,
		}
		const deleteTotpAuthenticatorByTotpVerificationCodeSelect: SelectType<UserTotpAuthenticator> = {
			secret: 1,
			backupCodeHash: 1,
			lastAttemptTime: 1,
			attempts: 1,
		}

		const selectResult = await selectDataFromMongoDB<UserTotpAuthenticator>(deleteTotpAuthenticatorByTotpVerificationCodeWhere, deleteTotpAuthenticatorByTotpVerificationCodeSelect, userTotpAuthenticatorSchemaInstance, userTotpAuthenticatorCollectionName, { session })
		if (!selectResult.success || selectResult.result.length !== 1) {
			if (session.inTransaction()) {
				await session.abortTransaction()
			}
			session.endSession()
			console.error('ERROR', '已登录用户通过密码和 TOTP 验证码删除身份验证器失败：删除失败，未找到匹配的数据')
			return { success: false, message: '已登录用户通过密码和 TOTP 验证码删除身份验证器失败：删除失败，未找到匹配的数据' }
		}

		let attempts = selectResult.result[0].attempts
		const totpSecret = selectResult.result[0].secret

		// 限制用户尝试删除的频率
		if (selectResult.result[0].attempts >= maxAttempts) {
			const lastAttemptTime = new Date(selectResult.result[0].lastAttemptTime).getTime();
			if (now - lastAttemptTime < lockTime) {
				attempts += 1

				if (session.inTransaction()) {
					await session.abortTransaction()
				}
				session.endSession()
				console.warn('WARN', 'WARNING', '已登录用户通过密码和 TOTP 验证码删除身份验证器失败，已达最大尝试次数，请稍后再试');
				return { success: false, message: '已登录用户通过密码和 TOTP 验证码删除身份验证器失败，已达最大尝试次数，请稍后再试', isCoolingDown: true }
			} else {
				attempts = 0
			}

			const deleteTotpAuthenticatorByTotpVerificationCodeUpdate: UpdateType<UserTotpAuthenticator> = {
				attempts: attempts,
				lastAttemptTime: now,
			}
			const updateAuthenticatorResult = await findOneAndUpdateData4MongoDB<UserTotpAuthenticator>(deleteTotpAuthenticatorByTotpVerificationCodeWhere, deleteTotpAuthenticatorByTotpVerificationCodeUpdate, userTotpAuthenticatorSchemaInstance, userTotpAuthenticatorCollectionName, { session })

			if (!updateAuthenticatorResult.success) {
				if (session.inTransaction()) {
					await session.abortTransaction()
				}
				session.endSession()
				console.error('ERROR', '已登录用户通过密码和 TOTP 验证码删除身份验证器失败，更新最后尝试时间或尝试次数失败');
				return { success: false, message: '已登录用户通过密码和 TOTP 验证码删除身份验证器失败，更新最后尝试时间或尝试次数失败', isCoolingDown: true }
			}
		}

		if (!authenticator.check(clientOtp, totpSecret)) {
			if (session.inTransaction()) {
				await session.abortTransaction()
			}
			session.endSession()
			console.error('ERROR', '已登录用户通过密码和邮 TOTP 证码删除身份验证器失败：删除失败，验证码错误')
			return { success: false, message: '已登录用户通过密码和 TOTP 验证码删除身份验证器失败：删除失败，验证码错误' }
		}

		// 调用删除函数
		const deleteResult = await deleteDataFromMongoDB(deleteTotpAuthenticatorByTotpVerificationCodeWhere, userTotpAuthenticatorSchemaInstance, userTotpAuthenticatorCollectionName, { session })
		const resetResult = await resetUser2FATypeByUUID(uuid, session)

		if (!deleteResult.success || deleteResult.result.deletedCount !== 1 || !resetResult) {
			if (session.inTransaction()) {
				await session.abortTransaction()
			}
			session.endSession()
			console.error('ERROR', '已登录用户通过密码和 TOTP 验证码删除身份验证器失败：删除失败，未找到匹配的数据或重置用户 2FA 数据失败')
			return { success: false, message: '已登录用户通过密码和 TOTP 验证码删除身份验证器失败：删除失败，未找到匹配的数据或重置用户 2FA 数据失败' }
		}

		await session.commitTransaction()
		session.endSession()
		return { success: true, message: '删除 TOTP 身份验证器成功' }
	} catch (error) {
		console.error('已登录用户通过密码和 TOTP 验证码删除身份验证器失败时出错，未知错误', error)
		return { success: false, message: '已登录用户通过密码和 TOTP 验证码删除身份验证器失败时出错，未知错误' }
	}
}

/**
 * 根据 UUID 重置 user-auth 表中用户的 authenticatorType 字段为 none，在 deleteTotpAuthenticatorByRecoveryCode, deleteTotpAuthenticatorByTotpVerificationCodeService 和 deleteUserEmailAuthenticatorService 中用到
 * @param uuid 用户的 UUID
 * @param session Mongoose Session
 * @returns boolean 执行是否成功
 */
const resetUser2FATypeByUUID = async (uuid: string, session: ClientSession): Promise<boolean> => {
	try {
		const { collectionName: userAuthCollectionName, schemaInstance: userAuthSchemaInstance } = UserAuthSchema
		type UserAuth = InferSchemaType<typeof userAuthSchemaInstance>
		const userAuthWhere: QueryType<UserAuth> = { UUID: uuid }
		const userAuthUpdate: UpdateType<UserAuth> = { authenticatorType: 'none' }

		const updateResult = await updateData4MongoDB<UserAuth>(userAuthWhere, userAuthUpdate, userAuthSchemaInstance, userAuthCollectionName, { session })

		return !!updateResult.success
	} catch (error) {
		console.error('ERROR', '根据 UUID 重置 user-auth 表中用户的 authenticatorType 字段时出错，未知错误：', error)
		return false
	}
}

/**
 * 用户创建 TOTP 身份验证器服务
 * 开启邮箱验证的是另一个函数，这个只是开启 totp
 * 这里只是创建，然后还有一个确认创建的步骤。
 *
 * @param uuid 用户的 UUID
 * @param token 用户的 token
 * @returns 用户创建 TOTP 身份验证器的请求响应
 */
export const createUserTotpAuthenticatorService = async (uuid: string, token: string): Promise<CreateUserTotpAuthenticatorResponseDto> => {
	try {
		if (!await checkUserTokenByUUID(uuid, token)) {
			console.error('创建 TOTP 身份验证器失败，非法用户', { uuid })
			return { success: false, isExists: false, message: '创建 TOTP 身份验证器失败，非法用户' }
		}

		const session = await mongoose.startSession()
		session.startTransaction()

		const { collectionName: userAuthCollectionName, schemaInstance: userAuthSchemaInstance } = UserAuthSchema
		type UserAuth = InferSchemaType<typeof userAuthSchemaInstance>

		const createUserTotpAuthenticatorUserAuthWhere: QueryType<UserAuth> = { UUID: uuid }
		const createUserTotpAuthenticatorUserAuthSelect: SelectType<UserAuth> = {
			authenticatorType: 1,
			email: 1,
		}

		const userAuthResult = await selectDataFromMongoDB<UserAuth>(createUserTotpAuthenticatorUserAuthWhere, createUserTotpAuthenticatorUserAuthSelect, userAuthSchemaInstance, userAuthCollectionName, { session })

		if (!userAuthResult.success || !userAuthResult?.result || userAuthResult.result?.length !== 1) {
			if (session.inTransaction()) {
				await session.abortTransaction()
			}
			session.endSession()
			console.error('创建 TOTP 身份验证器失败，用户不存在', { uuid })
			return { success: false, isExists: false, message: '创建 TOTP 身份验证器失败，用户不存在' }
		}

		if (userAuthResult.result[0].authenticatorType === 'email') {
			if (session.inTransaction()) {
				await session.abortTransaction()
			}
			session.endSession()
			console.error('创建 TOTP 身份验证器失败，已经开启 Email 2FA', { uuid })
			return { success: false, isExists: true, existsAuthenticatorType: 'email', message: '创建 TOTP 身份验证器失败，已经开启 Email 2FA' }
		}

		if (userAuthResult.result[0].authenticatorType === 'email') {
			if (session.inTransaction()) {
				await session.abortTransaction()
			}
			session.endSession()
			console.error('创建 TOTP 身份验证器失败，已经开启 TOTP 2FA', { uuid })
			return { success: false, isExists: true, existsAuthenticatorType: 'totp', message: '创建 TOTP 身份验证器失败，已经开启 TOTP 2FA' }
		}

		const { collectionName: userTotpAuthenticatorCollectionName, schemaInstance: userTotpAuthenticatorSchemaInstance } = UserTotpAuthenticatorSchema
		type UserAuthenticator = InferSchemaType<typeof userTotpAuthenticatorSchemaInstance>
		const checkUserAuthenticatorWhere: QueryType<UserAuthenticator> = { UUID: uuid, enabled: true }
		const checkUserAuthenticatorSelect: SelectType<UserAuthenticator> = { enabled: 1, createDateTime: 1 }
		const checkUserAuthenticatorResult = await selectDataFromMongoDB(checkUserAuthenticatorWhere, checkUserAuthenticatorSelect, userTotpAuthenticatorSchemaInstance, userTotpAuthenticatorCollectionName, { session })

		if (!checkUserAuthenticatorResult.success || !checkUserAuthenticatorResult.result) {
			if (session.inTransaction()) {
				await session.abortTransaction()
			}
			session.endSession()
			console.error('创建 TOTP 身份验证器失败，验证器唯一检查失败', { uuid })
			return { success: false, isExists: false, message: '创建身份验证器失败，验证器唯一检查失败' }
		}

		if (checkUserAuthenticatorResult.result.length >= 1) {
			if (session.inTransaction()) {
				await session.abortTransaction()
			}
			session.endSession()
			console.error('创建 TOTP 身份验证器失败，数据库中已经存储了一个启用的 TOTP 2FA', { uuid })
			return { success: false, isExists: true, existsAuthenticatorType: 'totp', message: '创建 TOTP 身份验证器失败，数据库中已经存储了一个启用的身份验证器' }
		}

		const now = new Date().getTime()
		const secret = authenticator.generateSecret()
		const email = userAuthResult.result[0].email
		const otpAuth = authenticator.keyuri(email, 'KIRAKIRA☆DOUGA', secret)
		const attempts = 0

		// 准备要插入的身份验证器数据
		const userAuthenticatorData: UserAuthenticator = {
			UUID: uuid,
			enabled: false,
			secret,
			otpAuth,
			backupCodeHash: [],
			attempts,
			lastAttemptTime: now,
			createDateTime: now,
			editDateTime: now,
		}

		// 插入数据到数据库
		const saveTotpAuthenticatorResult = await insertData2MongoDB<UserAuthenticator>(userAuthenticatorData, userTotpAuthenticatorSchemaInstance, userTotpAuthenticatorCollectionName, { session })

		if (!saveTotpAuthenticatorResult.success) {
			if (session.inTransaction()) {
				await session.abortTransaction()
			}
			session.endSession()
			console.error('创建 TOTP 身份验证器失败，保存数据失败', { uuid })
			return { success: false, isExists: false, message: '创建 TOTP 身份验证器失败，保存数据失败' }
		}

		await session.commitTransaction()
		session.endSession()
		return { success: true, isExists: false, message: '创建 TOTP 身份验证器成功', result: { otpAuth } }
	} catch (error) {
		console.error('创建 TOTP 身份验证器失败时出错，未知错误', error)
		return { success: false, isExists: false, message: '创建 TOTP 身份验证器时出错，未知错误' }
	}
}

/**
 * 用户确认绑定 TOTP 设备
 * @param confirmUserTotpAuthenticatorRequest 用户确认绑定 TOTP 设备的请求载荷
 * @param uuid 用户的 UUID
 * @param token 用户的 token
 * @returns 用户确认绑定 TOTP 设备的请求响应
 */
export const confirmUserTotpAuthenticatorService = async (confirmUserTotpAuthenticatorRequest: ConfirmUserTotpAuthenticatorRequestDto, uuid: string, token: string): Promise<ConfirmUserTotpAuthenticatorResponseDto> => {
	try {
		if (!await checkUserTokenByUUID(uuid, token)) {
			console.error('确认绑定 TOTP 设备失败，非法用户')
			return { success: false, message: '确认绑定 TOTP 设备失败，非法用户' }
		}

		const { clientOtp, otpAuth } = confirmUserTotpAuthenticatorRequest

		const { collectionName: userTotpAuthenticatorCollectionName, schemaInstance: userTotpAuthenticatorSchemaInstance } = UserTotpAuthenticatorSchema
		type UserAuthenticator = InferSchemaType<typeof userTotpAuthenticatorSchemaInstance>
		const confirmUserTotpAuthenticatorWhere: QueryType<UserAuthenticator> = {
			UUID: uuid,
			enabled: false,
			otpAuth,
		}
		const confirmUserTotpAuthenticatorSelect: SelectType<UserAuthenticator> = {
			secret: 1,
		}

		const session = await mongoose.startSession()
		session.startTransaction()

		const selectResult = await selectDataFromMongoDB<UserAuthenticator>(confirmUserTotpAuthenticatorWhere, confirmUserTotpAuthenticatorSelect, userTotpAuthenticatorSchemaInstance, userTotpAuthenticatorCollectionName, { session })

		if (!selectResult.success || selectResult.result.length !== 1) {
			if (session.inTransaction()) {
				await session.abortTransaction()
			}
			session.endSession()
			console.error('确认绑定 TOTP 设备失败，获取验证数据失败')
			return { success: false, message: '确认绑定 TOTP 设备失败，获取验证数据失败' }
		}

		const totpSecret = selectResult.result[0].secret
		if (!authenticator.check(clientOtp, totpSecret)) {
			if (session.inTransaction()) {
				await session.abortTransaction()
			}
			session.endSession()
			console.error('确认绑定 TOTP 设备失败，验证失败')
			return { success: false, message: '确认绑定 TOTP 设备失败，验证失败' }
		}

		const now = new Date().getTime()
		const charset = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
		const recoveryCode = generateSecureVerificationStringCode(24, charset)
		const recoveryCodeHash = hashPasswordSync(recoveryCode)
		const backupCode = Array.from({ length: 5 }, () => generateSecureVerificationStringCode(6, charset))
		const backupCodeHash = backupCode.map(hashPasswordSync)

		const confirmUserTotpAuthenticatorUpdate: UpdateType<UserAuthenticator> = {
			enabled: true,
			recoveryCodeHash,
			backupCodeHash,
			editDateTime: now,
		}

		const updateAuthenticatorResult = await findOneAndUpdateData4MongoDB<UserAuthenticator>(confirmUserTotpAuthenticatorWhere, confirmUserTotpAuthenticatorUpdate, userTotpAuthenticatorSchemaInstance, userTotpAuthenticatorCollectionName, { session })

		const { collectionName: userAuthCollectionName, schemaInstance: userAuthSchemaInstance } = UserAuthSchema
		type UserAuth = InferSchemaType<typeof userAuthSchemaInstance>

		const userAuthWhere: QueryType<UserAuth> = {
			UUID: uuid,
		}
		const userAuthUpdate: UpdateType<UserAuth> = {
			authenticatorType: 'totp',
		}
		const updateUserAuthResult = await findOneAndUpdateData4MongoDB<UserAuthenticator>(userAuthWhere, userAuthUpdate, userAuthSchemaInstance, userAuthCollectionName, { session })

		if (!updateAuthenticatorResult.success || !updateAuthenticatorResult.result || !updateUserAuthResult.success || !updateUserAuthResult.result) {
			if (session.inTransaction()) {
				await session.abortTransaction()
			}
			session.endSession()
			console.error('确认绑定 TOTP 设备失败，更新失败')
			return { success: false, message: '确认绑定 TOTP 设备失败，更新失败' }
		}

		await session.commitTransaction()
		session.endSession()
		return { success: true, result: { backupCode, recoveryCode }, message: '已绑定 TOTP 设备' }
	} catch (error) {
		console.error('确认绑定 TOTP 设备时出错，未知错误', error)
		return { success: false, message: '确认绑定 TOTP 设备时出错，未知错误' }
	}
}

/**
 * 用户创建 Email 身份验证器服务
 * @param uuid 用户的 UUID
 * @param token 用户的 token
 * @returns 用户创建 Email 身份验证器的请求响应
 */
export const createUserEmailAuthenticatorService = async (uuid: string, token: string): Promise<CreateUserEmailAuthenticatorResponseDto> => {
	try {
		if (!await checkUserTokenByUUID(uuid, token)) {
			console.error('创建 Email 身份验证器失败，非法用户', { uuid })
			return { success: false, isExists: false, message: '创建 Email 身份验证器失败，非法用户' }
		}

		const session = await mongoose.startSession()
		session.startTransaction()

		const { collectionName: userAuthCollectionName, schemaInstance: userAuthSchemaInstance } = UserAuthSchema
		type UserAuth = InferSchemaType<typeof userAuthSchemaInstance>

		const createUserEmailAuthenticatorUserAuthWhere: QueryType<UserAuth> = { UUID: uuid }
		const createUserEmailAuthenticatorUserAuthSelect: SelectType<UserAuth> = {
			authenticatorType: 1,
			emailLowerCase: 1,
			email: 1,
		}
		const userAuthResult = await selectDataFromMongoDB<UserAuth>(createUserEmailAuthenticatorUserAuthWhere, createUserEmailAuthenticatorUserAuthSelect, userAuthSchemaInstance, userAuthCollectionName, { session })
		if (!userAuthResult.success || !userAuthResult?.result || userAuthResult.result?.length !== 1) {
			if (session.inTransaction()) {
				await session.abortTransaction()
			}
			session.endSession()
			console.error('创建 TOTP 身份验证器失败，用户不存在', { uuid })
			return { success: false, isExists: false, message: '创建 TOTP 身份验证器失败，用户不存在' }
		}

		const email = userAuthResult.result[0].email
		const emailLowerCase = userAuthResult.result[0].emailLowerCase
		if (!emailLowerCase) {
			if (session.inTransaction()) {
				await session.abortTransaction()
			}
			session.endSession()
			console.error('创建 TOTP 身份验证器失败，未找到邮箱', { uuid })
			return { success: false, isExists: false, message: '创建 TOTP 身份验证器失败，未找到邮箱' }
		}

		if (userAuthResult.result[0].authenticatorType === 'email') {
			if (session.inTransaction()) {
				await session.abortTransaction()
			}
			session.endSession()
			console.error('创建 TOTP 身份验证器失败，已经开启 Email 2FA', { uuid })
			return { success: false, isExists: true, existsAuthenticatorType: 'email', message: '创建 TOTP 身份验证器失败，已经开启 Email 2FA' }
		}

		if (userAuthResult.result[0].authenticatorType === 'totp') {
			if (session.inTransaction()) {
				await session.abortTransaction()
			}
			session.endSession()
			console.error('创建 TOTP 身份验证器失败，已经开启 TOTP 2FA', { uuid })
			return { success: false, isExists: true, existsAuthenticatorType: 'totp', message: '创建 TOTP 身份验证器失败，已经开启 TOTP 2FA' }
		}

		const { collectionName: UserEmailAuthenticatorCollectionName, schemaInstance: userEmailAuthenticatorSchemaInstance } = UserEmailAuthenticatorSchema
		type UserAuthenticator = InferSchemaType<typeof userEmailAuthenticatorSchemaInstance>
		const checkUserAuthenticatorWhere: QueryType<UserAuthenticator> = { UUID: uuid, enabled: true }
		const checkUserAuthenticatorSelect: SelectType<UserAuthenticator> = {
			enabled: 1,
			createDateTime: 1
		}

		const checkUserAuthenticatorResult = await selectDataFromMongoDB(checkUserAuthenticatorWhere, checkUserAuthenticatorSelect, userEmailAuthenticatorSchemaInstance, UserEmailAuthenticatorCollectionName, { session })

		if (!checkUserAuthenticatorResult.success || !checkUserAuthenticatorResult.result) {
			if (session.inTransaction()) {
				await session.abortTransaction()
			}
			session.endSession()
			console.error('创建 Email 身份验证器失败，验证器唯一检查失败', { uuid })
			return { success: false, isExists: false, message: '创建身份验证器失败，验证器唯一检查失败' }
		}

		if (checkUserAuthenticatorResult.result.length >= 1) {
			if (session.inTransaction()) {
				await session.abortTransaction()
			}
			session.endSession()
			console.error('创建 Email 身份验证器失败，数据库中已经存储了一个启用的 Email 2FA', { uuid })
			return { success: false, isExists: true, existsAuthenticatorType: 'email', message: '创建 Email 身份验证器失败，数据库中已经存储了一个启用的' }
		}

		const now = new Date().getTime()

		// 准备要插入的身份验证器数据
		const userAuthenticatorData: UserAuthenticator = {
			UUID: uuid,
			enabled: true,
			emailLowerCase,
			createDateTime: now,
			editDateTime: now,
		}

		// 插入数据到数据库
		const saveEmailAuthenticatorResult = await insertData2MongoDB<UserAuthenticator>(userAuthenticatorData, userEmailAuthenticatorSchemaInstance, UserEmailAuthenticatorCollectionName, { session })

		if (!saveEmailAuthenticatorResult.success) {
			if (session.inTransaction()) {
				await session.abortTransaction()
			}
			session.endSession()
			console.error('创建 Email 身份验证器失败，保存数据失败-1', { uuid })
			return { success: false, isExists: false, message: '创建 Email 身份验证器失败，保存数据失败-1' }
		}
		const userAuthWhere: QueryType<UserAuth> = {
			UUID: uuid,
		}
		const userAuthUpdate: UpdateType<UserAuth> = {
			authenticatorType: 'email',
			editDateTime: now,
		}
		const updateUserAuthResult = await findOneAndUpdateData4MongoDB<UserAuthenticator>(userAuthWhere, userAuthUpdate, userAuthSchemaInstance, userAuthCollectionName, { session })

		if (!updateUserAuthResult.success || !updateUserAuthResult.result) {
			if (session.inTransaction()) {
				await session.abortTransaction()
			}
			session.endSession()
			console.error('创建 Email 身份验证器失败，保存数据失败-2', { uuid })
			return { success: false, isExists: false, message: '创建 Email 身份验证器失败，保存数据失败-2' }
		}

		await session.commitTransaction()
		session.endSession()
		return { success: true, isExists: false, message: '创建 Email 身份验证器成功', result: { email, emailLowerCase } }
	} catch (error) {
		console.error('创建 Email 身份验证器失败时出错，未知错误', error)
		return { success: false, isExists: false, message: '创建 Email 身份验证器时出错，未知错误' }
	}
}

/**
 * 用户发送 Email 身份验证器验证邮件
 * @param sendUserEmailAuthenticatorRequestDto 用户发送 Email 身份验证器验证邮件的请求载荷
 * @returns 用户发送 Email 身份验证器验证邮件的请求响应
 */
export const sendUserEmailAuthenticatorService = async (sendUserEmailAuthenticatorVerificationCodeRequest: SendUserEmailAuthenticatorVerificationCodeRequestDto): Promise<SendUserEmailAuthenticatorVerificationCodeResponseDto> => {
	try {
		if (!checkSendUserEmailAuthenticatorVerificationCodeRequest(sendUserEmailAuthenticatorVerificationCodeRequest)) {
			console.error('ERROR', '请求发送身份验证器的邮箱验证码失败，参数不合法')
			return { success: false, isCoolingDown: false, message: '请求发送身份验证器的邮箱验证码失败，参数不合法' }
		}

		const { clientLanguage, email, passwordHash } = sendUserEmailAuthenticatorVerificationCodeRequest
		const emailLowerCase = email.toLowerCase()

		const nowTime = new Date().getTime()
		const todayStart = new Date()
		todayStart.setHours(0, 0, 0, 0)

		// 启动事务
		const session = await createAndStartSession()

		const { collectionName: userAuthCollectionName, schemaInstance: userAuthSchemaInstance } = UserAuthSchema

		type UserAuth = InferSchemaType<typeof userAuthSchemaInstance>

		const sendUserEmailAuthenticatorUserAuthWhere: QueryType<UserAuth> = { emailLowerCase: emailLowerCase }
		const sendUserEmailAuthenticatorUserAuthSelect: SelectType<UserAuth> = {
			passwordHashHash: 1,
			authenticatorType: 1,
			UUID: 1,
		}
		const userAuthResult = await selectDataFromMongoDB<UserAuth>(sendUserEmailAuthenticatorUserAuthWhere, sendUserEmailAuthenticatorUserAuthSelect, userAuthSchemaInstance, userAuthCollectionName, { session })
		const userAuthData = userAuthResult.result?.[0]
		const { UUID: uuid, passwordHashHash } = userAuthData

		if (!userAuthResult.success || userAuthResult.result?.length !== 1 || !email) {
			await abortAndEndSession(session)
			console.error('请求发送身份验证器的邮箱验证码失败，用户不存在')
			return { success: false, isCoolingDown: false, message: '请求发送身份验证器的邮箱验证码失败，用户不存在' }
		}

		const isCorrectPassword = comparePasswordSync(passwordHash, passwordHashHash)
		if (!isCorrectPassword) {
			await abortAndEndSession(session)
			console.error('请求发送身份验证器的邮箱验证码失败，密码错误')
			return { success: false, isCoolingDown: false, message: '请求发送身份验证器的邮箱验证码失败，密码错误' }
		}

		if (userAuthData.authenticatorType !== 'email') {
			await abortAndEndSession(session)
			console.error('请求发送身份验证器的邮箱验证码失败，用户未开启 2FA 或者 2FA 方式不是 Email。')
			return { success: false, isCoolingDown: false, message: '请求发送身份验证器的邮箱验证码失败，用户未开启 2FA 或者 2FA 方式不是 Email。' }
		}

		const { collectionName: userEmailAuthenticatorVerificationCodeCollectionName, schemaInstance: userEmailAuthenticatorVerificationCodeSchemaInstance } = UserEmailAuthenticatorVerificationCodeSchema
		type UserEmailAuthenticatorVerificationCode = InferSchemaType<typeof userEmailAuthenticatorVerificationCodeSchemaInstance>
		const requestSendEmailAuthenticatorByEmailVerificationCodeWhere: QueryType<UserEmailAuthenticatorVerificationCode> = {
			UUID: uuid,
		}

		const requestSendEmailAuthenticatorByEmailVerificationCodeSelect: SelectType<UserEmailAuthenticatorVerificationCode> = {
			emailLowerCase: 1, // 用户邮箱
			attemptsTimes: 1, // 验证码请求次数
			lastRequestDateTime: 1, // 用户上一次请求验证码的时间，用于防止滥用
		}

		const requestSendEmailAuthenticatorByEmailVerificationCodeResult = await selectDataFromMongoDB<UserEmailAuthenticatorVerificationCode>(requestSendEmailAuthenticatorByEmailVerificationCodeWhere, requestSendEmailAuthenticatorByEmailVerificationCodeSelect, userEmailAuthenticatorVerificationCodeSchemaInstance, userEmailAuthenticatorVerificationCodeCollectionName, { session })

		if (!requestSendEmailAuthenticatorByEmailVerificationCodeResult.success) {
			if (session.inTransaction()) {
				await session.abortTransaction()
			}
			session.endSession()
			console.error('ERROR', '请求发送身份验证器的邮箱验证码失败，获取验证码失败')
			return { success: false, isCoolingDown: false, message: '请求发送身份验证器的邮箱验证码失败，获取验证码失败' }
		}

		const lastRequestDateTime = requestSendEmailAuthenticatorByEmailVerificationCodeResult.result?.[0]?.lastRequestDateTime ?? 0
		if (requestSendEmailAuthenticatorByEmailVerificationCodeResult.result.length >= 1 && lastRequestDateTime + 55000 > nowTime) { // 是否仍在冷却，前端 60 秒，后端 55 秒
			if (session.inTransaction()) {
				await session.abortTransaction()
			}
			session.endSession()
			console.warn('WARN', 'WARNING', '请求发送身份验证器的邮箱验证码失败，未超过邮件超时时间，请稍后再试')
			return { success: true, isCoolingDown: true, message: '请求发送身份验证器的邮箱验证码失败，未超过邮件超时时间，请稍后再试' }
		}

		const attemptsTimes = requestSendEmailAuthenticatorByEmailVerificationCodeResult.result?.[0]?.attemptsTimes ?? 0
		const lastRequestDate = new Date(lastRequestDateTime)
		if (requestSendEmailAuthenticatorByEmailVerificationCodeResult.result.length >= 1 && todayStart < lastRequestDate && attemptsTimes > 5) { // ! 每天五次机会
			if (session.inTransaction()) {
				await session.abortTransaction()
			}
			session.endSession()
			console.warn('WARN', 'WARNING', '请求发送身份验证器的邮箱验证码失败，已达本日重复次数上限，请稍后再试')
			return { success: true, isCoolingDown: true, message: '请求发送身份验证器的邮箱验证码失败，已达本日重复次数上限，请稍后再试' }
		}

		const verificationCode = generateSecureVerificationNumberCode(6) // 生成六位随机数验证码
		let newAttemptsTimes = attemptsTimes + 1
		if (todayStart > lastRequestDate) {
			newAttemptsTimes = 0
		}

		const requestSeDeleteTotpAuthenticatorVerificationCodeUpdate: UpdateType<UserEmailAuthenticatorVerificationCode> = {
			verificationCode,
			overtimeAt: nowTime + 1800000, // 当前时间加上 1800000 毫秒（30 分钟）作为新的过期时间
			attemptsTimes: newAttemptsTimes,
			lastRequestDateTime: nowTime,
			editDateTime: nowTime,
		}

		const updateResult = await findOneAndUpdateData4MongoDB(requestSendEmailAuthenticatorByEmailVerificationCodeWhere, requestSeDeleteTotpAuthenticatorVerificationCodeUpdate, userEmailAuthenticatorVerificationCodeSchemaInstance, userEmailAuthenticatorVerificationCodeCollectionName, { session })

		if (!updateResult.success) {
			if (session.inTransaction()) {
				await session.abortTransaction()
			}
			session.endSession()
			console.error('ERROR', '请求发送身份验证器的邮箱验证码失败，更新或新增用户验证码失败')
			return { success: false, isCoolingDown: false, message: '请求发送身份验证器的邮箱验证码失败，更新或新增用户验证码失败' }
		}

		// TODO: 使用多语言 email title and text
		try {
			const mailTitleCHS = 'KIRAKIRA - 验证 2FA 的验证码'
			const mailTitleEN = 'KIRAKIRA - Verification Code For Verifying 2FA'
			const correctMailTitle = clientLanguage === 'zh-Hans-CN' ? mailTitleCHS : mailTitleEN

			// 请不要使用 “您”
			const mailHtmlCHS = `
					<p>验证 2FA 的验证码是：<strong>${verificationCode}</strong></p>
					注意：你可以使用这个验证码来验证你的 2FA（二重身份验证器）。
					<br>
					验证码 30 分钟内有效。请注意安全，不要向他人泄露你的验证码。
				`
			const mailHtmlEN = `
					<p>Your verification code for verifying Authenticator is: <strong>${verificationCode}</strong></p>
					Note: Please make sure you will use this verification code to verify your Authenticator.
					<br>
					Verification code is valid for 30 minutes. Please ensure do not disclose your verification code to others.
					<br>
					<br>
					To stop receiving notifications, please contact the KIRAKIRA support team.
				`
			const correctMailHTML = clientLanguage === 'zh-Hans-CN' ? mailHtmlCHS : mailHtmlEN

			const sendMailResult = await sendMail(email, correctMailTitle, { html: correctMailHTML })
			if (!sendMailResult.success) {
				if (session.inTransaction()) {
					await session.abortTransaction()
				}
				session.endSession()
				console.error('ERROR', '请求发送验证身份验证器的邮箱验证码失败，邮件发送失败')
				return { success: false, isCoolingDown: true, message: '请求发送验证身份验证器的邮箱验证码失败，邮件发送失败' }
			}

			await session.commitTransaction()
			session.endSession()
			return { success: true, isCoolingDown: false, message: '验证身份验证器的邮箱验证码已发送至你注册时使用的邮箱，请注意查收，如未收到，请检查垃圾箱或联系 KIRAKIRA 客服。' }
		} catch (error) {
			if (session.inTransaction()) {
				await session.abortTransaction()
			}
			session.endSession()
			console.error('ERROR', '请求发送验证身份验证器的邮箱验证码时出错，邮件发送时出错', error)
			return { success: false, isCoolingDown: true, message: '请求发送验证身份验证器的邮箱验证码时出错，邮件发送时出错' }
		}
	} catch (error) {
		console.error('ERROR', '请求发送验证身份验证器的邮箱验证码时出错，未知错误', error)
		return { success: false, isCoolingDown: false, message: '请求发送验证身份验证器的邮箱验证码时出错，未知错误' }
	}
}

/**
 * 用户发送删除 Email 身份验证器验证邮件
 * @param sendDeleteUserEmailAuthenticatorVerificationCodeRequest 用户发送删除 Email 身份验证器验证邮件的请求载荷
 * @returns 用户发送 Email 身份验证器验证邮件的请求响应
 */
export const sendDeleteUserEmailAuthenticatorService = async (sendDeleteUserEmailAuthenticatorVerificationCodeRequest: SendDeleteUserEmailAuthenticatorVerificationCodeRequestDto, uuid: string, token: string): Promise<SendDeleteUserEmailAuthenticatorVerificationCodeResponseDto> => {
	try {
		if (!checkSendDeleteUserEmailAuthenticatorVerificationCodeRequest(sendDeleteUserEmailAuthenticatorVerificationCodeRequest)) {
			console.error('ERROR', '请求发送身份验证器的邮箱验证码失败，参数不合法')
			return { success: false, isCoolingDown: false, message: '请求发送身份验证器的邮箱验证码失败，参数不合法' }
		}

		if (!await checkUserTokenByUUID(uuid, token)) {
			console.error('请求发送身份验证器的邮箱验证码失败，用户校验未通过')
			return { success: false, isCoolingDown: false, message: '请求发送身份验证器的邮箱验证码失败，用户校验未通过' }
		}

		const { clientLanguage } = sendDeleteUserEmailAuthenticatorVerificationCodeRequest

		const nowTime = new Date().getTime()
		const todayStart = new Date()
		todayStart.setHours(0, 0, 0, 0)

		// 启动事务
		const session = await createAndStartSession()

		const { collectionName: userAuthCollectionName, schemaInstance: userAuthSchemaInstance } = UserAuthSchema

		type UserAuth = InferSchemaType<typeof userAuthSchemaInstance>

		const sendDeleteUserEmailAuthenticatorUserAuthWhere: QueryType<UserAuth> = { UUID: uuid }
		const sendDeleteUserEmailAuthenticatorUserAuthSelect: SelectType<UserAuth> = {
			authenticatorType: 1,
			email: 1,
		}
		const userAuthResult = await selectDataFromMongoDB<UserAuth>(sendDeleteUserEmailAuthenticatorUserAuthWhere, sendDeleteUserEmailAuthenticatorUserAuthSelect, userAuthSchemaInstance, userAuthCollectionName, { session })
		const userAuthData = userAuthResult.result?.[0]
		const { authenticatorType, email } = userAuthData

		if (!userAuthResult.success || userAuthResult.result?.length !== 1 || !email) {
			await abortAndEndSession(session)
			console.error('请求发送身份验证器的邮箱验证码失败，用户不存在')
			return { success: false, isCoolingDown: false, message: '请求发送身份验证器的邮箱验证码失败，用户不存在' }
		}

		if (authenticatorType !== 'email') {
			await abortAndEndSession(session)
			console.error('请求发送身份验证器的邮箱验证码失败，用户未开启 2FA 或者 2FA 方式不是 Email。')
			return { success: false, isCoolingDown: false, message: '请求发送身份验证器的邮箱验证码失败，用户未开启 2FA 或者 2FA 方式不是 Email。' }
		}

		const { collectionName: userEmailAuthenticatorVerificationCodeCollectionName, schemaInstance: userEmailAuthenticatorVerificationCodeSchemaInstance } = UserEmailAuthenticatorVerificationCodeSchema
		type UserEmailAuthenticatorVerificationCode = InferSchemaType<typeof userEmailAuthenticatorVerificationCodeSchemaInstance>
		const requestSendEmailAuthenticatorByEmailVerificationCodeWhere: QueryType<UserEmailAuthenticatorVerificationCode> = {
			UUID: uuid,
		}

		const requestSendEmailAuthenticatorByEmailVerificationCodeSelect: SelectType<UserEmailAuthenticatorVerificationCode> = {
			emailLowerCase: 1, // 用户邮箱
			attemptsTimes: 1, // 验证码请求次数
			lastRequestDateTime: 1, // 用户上一次请求验证码的时间，用于防止滥用
		}

		const requestSendEmailAuthenticatorByEmailVerificationCodeResult = await selectDataFromMongoDB<UserEmailAuthenticatorVerificationCode>(requestSendEmailAuthenticatorByEmailVerificationCodeWhere, requestSendEmailAuthenticatorByEmailVerificationCodeSelect, userEmailAuthenticatorVerificationCodeSchemaInstance, userEmailAuthenticatorVerificationCodeCollectionName, { session })

		if (!requestSendEmailAuthenticatorByEmailVerificationCodeResult.success) {
			if (session.inTransaction()) {
				await session.abortTransaction()
			}
			session.endSession()
			console.error('ERROR', '请求发送身份验证器的邮箱验证码失败，获取验证码失败')
			return { success: false, isCoolingDown: false, message: '请求发送身份验证器的邮箱验证码失败，获取验证码失败' }
		}

		const lastRequestDateTime = requestSendEmailAuthenticatorByEmailVerificationCodeResult.result?.[0]?.lastRequestDateTime ?? 0
		if (requestSendEmailAuthenticatorByEmailVerificationCodeResult.result.length >= 1 && lastRequestDateTime + 55000 > nowTime) { // 是否仍在冷却，前端 60 秒，后端 55 秒
			if (session.inTransaction()) {
				await session.abortTransaction()
			}
			session.endSession()
			console.warn('WARN', 'WARNING', '请求发送身份验证器的邮箱验证码失败，未超过邮件超时时间，请稍后再试')
			return { success: true, isCoolingDown: true, message: '请求发送身份验证器的邮箱验证码失败，未超过邮件超时时间，请稍后再试' }
		}

		const attemptsTimes = requestSendEmailAuthenticatorByEmailVerificationCodeResult.result?.[0]?.attemptsTimes ?? 0
		const lastRequestDate = new Date(lastRequestDateTime)
		if (requestSendEmailAuthenticatorByEmailVerificationCodeResult.result.length >= 1 && todayStart < lastRequestDate && attemptsTimes > 5) { // ! 每天五次机会
			if (session.inTransaction()) {
				await session.abortTransaction()
			}
			session.endSession()
			console.warn('WARN', 'WARNING', '请求发送身份验证器的邮箱验证码失败，已达本日重复次数上限，请稍后再试')
			return { success: true, isCoolingDown: true, message: '请求发送身份验证器的邮箱验证码失败，已达本日重复次数上限，请稍后再试' }
		}

		const verificationCode = generateSecureVerificationNumberCode(6) // 生成六位随机数验证码
		let newAttemptsTimes = attemptsTimes + 1
		if (todayStart > lastRequestDate) {
			newAttemptsTimes = 0
		}

		const requestSeDeleteTotpAuthenticatorVerificationCodeUpdate: UpdateType<UserEmailAuthenticatorVerificationCode> = {
			verificationCode,
			overtimeAt: nowTime + 1800000, // 当前时间加上 1800000 毫秒（30 分钟）作为新的过期时间
			attemptsTimes: newAttemptsTimes,
			lastRequestDateTime: nowTime,
			editDateTime: nowTime,
		}

		const updateResult = await findOneAndUpdateData4MongoDB(requestSendEmailAuthenticatorByEmailVerificationCodeWhere, requestSeDeleteTotpAuthenticatorVerificationCodeUpdate, userEmailAuthenticatorVerificationCodeSchemaInstance, userEmailAuthenticatorVerificationCodeCollectionName, { session })

		if (!updateResult.success) {
			if (session.inTransaction()) {
				await session.abortTransaction()
			}
			session.endSession()
			console.error('ERROR', '请求发送身份验证器的邮箱验证码失败，更新或新增用户验证码失败')
			return { success: false, isCoolingDown: false, message: '请求发送身份验证器的邮箱验证码失败，更新或新增用户验证码失败' }
		}

		// TODO: 使用多语言 email title and text
		try {
			const mailTitleCHS = 'KIRAKIRA - 删除 2FA 的验证码'
			const mailTitleEN = 'KIRAKIRA - Verification Code For Delete 2FA'
			const correctMailTitle = clientLanguage === 'zh-Hans-CN' ? mailTitleCHS : mailTitleEN

			// 请不要使用 “您”
			const mailHtmlCHS = `
					<p>删除 2FA 的验证码是：<strong>${verificationCode}</strong></p>
					注意：你可以使用这个验证码来删除你的 2FA（二重身份验证器）。
					<br>
					验证码 30 分钟内有效。请注意安全，不要向他人泄露你的验证码。
				`
			const mailHtmlEN = `
					<p>Your verification code for delete Authenticator is: <strong>${verificationCode}</strong></p>
					Note: Please make sure you will use this verification code to delete your Authenticator.
					<br>
					Verification code is valid for 30 minutes. Please ensure do not disclose your verification code to others.
					<br>
					<br>
					To stop receiving notifications, please contact the KIRAKIRA support team.
				`
			const correctMailHTML = clientLanguage === 'zh-Hans-CN' ? mailHtmlCHS : mailHtmlEN

			const sendMailResult = await sendMail(email, correctMailTitle, { html: correctMailHTML })
			if (!sendMailResult.success) {
				if (session.inTransaction()) {
					await session.abortTransaction()
				}
				session.endSession()
				console.error('ERROR', '请求发送验证身份验证器的邮箱验证码失败，邮件发送失败')
				return { success: false, isCoolingDown: true, message: '请求发送验证身份验证器的邮箱验证码失败，邮件发送失败' }
			}

			await session.commitTransaction()
			session.endSession()
			return { success: true, isCoolingDown: false, message: '验证身份验证器的邮箱验证码已发送至你注册时使用的邮箱，请注意查收，如未收到，请检查垃圾箱或联系 KIRAKIRA 客服。' }
		} catch (error) {
			if (session.inTransaction()) {
				await session.abortTransaction()
			}
			session.endSession()
			console.error('ERROR', '请求发送验证身份验证器的邮箱验证码时出错，邮件发送时出错', error)
			return { success: false, isCoolingDown: true, message: '请求发送验证身份验证器的邮箱验证码时出错，邮件发送时出错' }
		}
	} catch (error) {
		console.error('ERROR', '请求发送验证身份验证器的邮箱验证码时出错，未知错误', error)
		return { success: false, isCoolingDown: false, message: '请求发送验证身份验证器的邮箱验证码时出错，未知错误' }
	}
}

/**
 * 验证邮箱身份验证器的验证码是否正确
 * @param checkEmailAuthenticatorVerificationCodeRequest 用户通过邮箱验证码验证身份验证器的请求载荷
 * @returns 删除操作的结果
 */
const checkEmailAuthenticatorVerificationCodeService = async (checkEmailAuthenticatorVerificationCodeRequest: CheckEmailAuthenticatorVerificationCodeRequestDto): Promise<CheckEmailAuthenticatorVerificationCodeResponseDto> => {
	try {
		if (!checkEmailAuthenticatorVerificationCodeRequest.email && !checkEmailAuthenticatorVerificationCodeRequest.verificationCode) {
			console.error('ERROR', '用户通过邮箱验证码验证身份验证器失败时失败，参数不合法')
			return { success: false, message: '用户通过邮箱验证码验证身份验证器失败时失败，参数不合法' }
		}

		const session = await mongoose.startSession()
		session.startTransaction()

		const now = new Date().getTime()
		const { email, verificationCode } = checkEmailAuthenticatorVerificationCodeRequest

		const emailLowerCase = email.toLowerCase()

		const { collectionName: userAuthCollectionName, schemaInstance: userAuthSchemaInstance } = UserAuthSchema
		type UserAuth = InferSchemaType<typeof userAuthSchemaInstance>

		const checkEmailAuthenticatorVerificationCodeUserAuthWhere: QueryType<UserAuth> = { emailLowerCase }
		const checkEmailAuthenticatorVerificationCodeUserAuthSelect: SelectType<UserAuth> = {
			UUID: 1,
		}
		const userAuthResult = await selectDataFromMongoDB<UserAuth>(checkEmailAuthenticatorVerificationCodeUserAuthWhere, checkEmailAuthenticatorVerificationCodeUserAuthSelect, userAuthSchemaInstance, userAuthCollectionName, { session })
		const uuid = userAuthResult.result?.[0].UUID

		if (!userAuthResult || !userAuthResult.success || !uuid) {
			console.error('ERROR', '用户通过邮箱验证码验证身份验证器失败时失败，用户不存在')
			return { success: false, message: '用户通过邮箱验证码验证身份验证器失败时失败，用户不存在' }
		}

		const { collectionName: UserEmailAuthenticatorVerificationCodeCollectionName, schemaInstance: UserEmailAuthenticatorVerificationCodeSchemaInstance } = UserEmailAuthenticatorVerificationCodeSchema

		type UserEmailAuthenticatorVerificationCode = InferSchemaType<typeof UserEmailAuthenticatorVerificationCodeSchemaInstance>
		const checkDeleteTotpAuthenticatorEmailVerificationCodeWhere: QueryType<UserEmailAuthenticatorVerificationCode> = {
			UUID: uuid,
			verificationCode,
			overtimeAt: { $gte: now },
		}
		const checkDeleteTotpAuthenticatorEmailVerificationCodeSelect: SelectType<UserEmailAuthenticatorVerificationCode> = {
			emailLowerCase: 1, // 用户邮箱
		}

		const checkUserEmailAuthenticatorVerificationCodeResult = await selectDataFromMongoDB<UserEmailAuthenticatorVerificationCode>(checkDeleteTotpAuthenticatorEmailVerificationCodeWhere, checkDeleteTotpAuthenticatorEmailVerificationCodeSelect, UserEmailAuthenticatorVerificationCodeSchemaInstance, UserEmailAuthenticatorVerificationCodeCollectionName, { session })

		if (!checkUserEmailAuthenticatorVerificationCodeResult.success || checkUserEmailAuthenticatorVerificationCodeResult.result?.length !== 1) {
			if (session.inTransaction()) {
				await session.abortTransaction()
			}
			session.endSession()
			console.error('ERROR', '已登录用户通过密码和邮箱验证码删除身份验证器失败：邮箱验证码验证失败')
			return { success: false, message: '已登录用户通过密码和邮箱验证码删除身份验证器失败：邮箱验证码验证失败' }
		}

		await session.commitTransaction()
		session.endSession()
		return { success: true, message: '验证身份验证器成功' }
	} catch (error) {
		console.error('用户通过邮箱验证码验证身份验证器失败时出错，未知错误', error)
		return { success: false, message: '用户通过邮箱验证码验证身份验证器失败时出错，未知错误' }
	}
}

/**
 * 用户删除 Email 2FA
 * @param deleteUserEmailAuthenticatorRequest
 * @param uuid 用户的 UUID
 * @param token 用户的 token
 */
export const deleteUserEmailAuthenticatorService = async (deleteUserEmailAuthenticatorRequest: DeleteUserEmailAuthenticatorRequestDto, uuid: string, token: string): Promise<DeleteUserEmailAuthenticatorResponseDto> => {
	try {
		if (!checkDeleteUserEmailAuthenticatorRequest(deleteUserEmailAuthenticatorRequest)) {
			console.error('用户删除 Email 2FA 时失败，参数非法')
			return { success: false, message: '用户删除 Email 2FA 时失败，参数非法' }
		}

		if (!await checkUserTokenByUUID(uuid, token)) {
			console.error('用户删除 Email 2FA 时失败，用户校验未通过')
			return { success: false, message: '用户删除 Email 2FA 时失败，用户校验未通过' }
		}

		const { passwordHash, verificationCode } = deleteUserEmailAuthenticatorRequest

		const session = await mongoose.startSession()
		session.startTransaction()

		const { collectionName: userAuthCollectionName, schemaInstance: userAuthSchemaInstance } = UserAuthSchema
		type UserAuth = InferSchemaType<typeof userAuthSchemaInstance>

		const deleteUserEmailAuthenticatorUserAuthWhere: QueryType<UserAuth> = { UUID: uuid }
		const deleteUserEmailAuthenticatorUserAuthSelect: SelectType<UserAuth> = {
			authenticatorType: 1,
			emailLowerCase: 1,
			email: 1,
			passwordHashHash: 1,
		}
		const userAuthResult = await selectDataFromMongoDB<UserAuth>(deleteUserEmailAuthenticatorUserAuthWhere, deleteUserEmailAuthenticatorUserAuthSelect, userAuthSchemaInstance, userAuthCollectionName, { session })
		const userAuthData = userAuthResult.result?.[0]

		if (!userAuthResult.success || userAuthResult.result?.length !== 1) {
			await abortAndEndSession(session)
			console.error('用户删除 Email 2FA 时失败，用户不存在')
			return { success: false, message: '用户删除 Email 2FA 时失败，用户不存在' }
		}

		if (userAuthData.authenticatorType !== 'email') {
			await abortAndEndSession(session)
			console.error('用户删除 Email 2FA 时失败，用户未开启 2FA 或者 2FA 方式不是 Email。')
			return { success: false, message: '用户删除 Email 2FA 时失败，用户未开启 2FA 或者 2FA 方式不是 Email。' }
		}

		const isCorrectPassword = comparePasswordSync(passwordHash, userAuthData.passwordHashHash)
		if (!isCorrectPassword) {
			await abortAndEndSession(session)
			console.error('用户删除 Email 2FA 时失败，密码错误')
			return { success: false, message: '用户删除 Email 2FA 时失败，密码错误' }
		}

		const checkEmailAuthenticatorVerificationCodeRequest: CheckEmailAuthenticatorVerificationCodeRequestDto = {
			email: userAuthData.emailLowerCase,
			verificationCode,
		}
		const verificationCodeCheckResult = await checkEmailAuthenticatorVerificationCodeService(checkEmailAuthenticatorVerificationCodeRequest)

		if (!verificationCodeCheckResult || !verificationCodeCheckResult.success) {
			await abortAndEndSession(session)
			console.error('用户删除 Email 2FA 时失败，验证失败或验证码错误')
			return { success: false, message: '用户删除 Email 2FA 时失败，验证失败或验证码错误' }
		}

		// 1. 清理已经发送的验证码
		const { collectionName: UserEmailAuthenticatorVerificationCodeCollectionName, schemaInstance: UserEmailAuthenticatorVerificationCodeSchemaInstance } = UserEmailAuthenticatorVerificationCodeSchema
		type UserEmailAuthenticatorVerificationCode = InferSchemaType<typeof UserEmailAuthenticatorVerificationCodeSchemaInstance>
		const deleteUserEmailAuthenticatorVerificationCodeWhere: QueryType<UserEmailAuthenticatorVerificationCode> = { UUID: uuid }
		const deleteUserEmailAuthenticatorVerificationCodeResult = await deleteDataFromMongoDB(deleteUserEmailAuthenticatorVerificationCodeWhere, UserEmailAuthenticatorVerificationCodeSchemaInstance, UserEmailAuthenticatorVerificationCodeCollectionName, { session })

		if (!deleteUserEmailAuthenticatorVerificationCodeResult || !deleteUserEmailAuthenticatorVerificationCodeResult.success) {
			await abortAndEndSession(session)
			console.error('用户删除 Email 2FA 时失败，清理该用户的验证码失败', { UUID: uuid })
			return { success: false, message: '用户删除 Email 2FA 时失败，清理该用户的验证码失败' }
		}

		// 2. 删除 Email 2FA
		const { collectionName: UserEmailAuthenticatorCollectionName, schemaInstance: UserEmailAuthenticatorSchemaInstance } = UserEmailAuthenticatorSchema
		type UserEmailAuthenticator = InferSchemaType<typeof UserEmailAuthenticatorSchemaInstance>
		const deleteUserEmailAuthenticatorWhere: QueryType<UserEmailAuthenticator> = { UUID: uuid }
		const deleteUserEmailAuthenticatorResult = await deleteDataFromMongoDB(deleteUserEmailAuthenticatorWhere, UserEmailAuthenticatorSchemaInstance, UserEmailAuthenticatorCollectionName, { session })

		if (!deleteUserEmailAuthenticatorResult || !deleteUserEmailAuthenticatorResult.success) {
			await abortAndEndSession(session)
			console.error('用户删除 Email 2FA 时失败，删除该用户的邮箱验证失败', { UUID: uuid })
			return { success: false, message: '用户删除 Email 2FA 时失败，删除该用户的邮箱验证失败' }
		}

		// 3. 重置用户的 2FA 类型
		const resetUser2FATypeByUUIDResult = await resetUser2FATypeByUUID(uuid, session)

		if (!resetUser2FATypeByUUIDResult) {
			await abortAndEndSession(session)
			console.error('用户删除 Email 2FA 时失败，用户关闭 2FA 失败', { UUID: uuid })
			return { success: false, message: '用户删除 Email 2FA 时失败，用户关闭 2FA 失败' }
		}

		await commitSession(session)
		return { success: true, message: '用户删除 Email 2FA 成功' }
	} catch (error) {
		console.error('用户删除 Email 2FA 时出错，未知错误', error)
		return { success: false, message: '用户删除 Email 2FA 时出错，未知错误' }
	}
}

/**
 * 通过 Email 检查用户是否已开启 2FA 身份验证器
 * @param checkUserHave2FARequestDto 通过 Email 检查用户是否已开启 2FA 身份验证器的请求载荷
 * @returns 通过 Email 检查用户是否已开启 2FA 身份验证器的请求响应
 */
export const checkUserHave2FAByEmailService = async (checkUserHave2FARequestDto: CheckUserHave2FARequestDto): Promise<CheckUserHave2FAResponseDto> => {
	try {
		const { email } = checkUserHave2FARequestDto
		if (!email) {
			console.error('ERROR', `通过 Email 检查用户是否已开启 2FA 身份验证器失败，邮箱为空`)
			return { success: false, have2FA: false, message: '通过 Email 检查用户是否已开启 2FA 身份验证器失败，邮箱为空' }
		}

		const emailLowerCase = email.toLowerCase()

		const { collectionName, schemaInstance } = UserAuthSchema
		type UserAuth = InferSchemaType<typeof schemaInstance>

		const userAuthWhere: QueryType<UserAuth> = { emailLowerCase }
		const userAuthSelect: SelectType<UserAuth> = { authenticatorType: 1, UUID: 1 }

		const userAuthResult = await selectDataFromMongoDB<UserAuth>(userAuthWhere, userAuthSelect, schemaInstance, collectionName)
		if (!userAuthResult?.result || userAuthResult.result?.length !== 1) {
			console.error('ERROR', `通过 Email 检查用户是否已开启 2FA 身份验证器失败，未找到用户数据`)
			return { success: false, have2FA: false, message: '通过 Email 检查用户是否已开启 2FA 身份验证器失败，未找到用户数据' }
		}

		const UUID = userAuthResult.result[0].UUID
		if (!UUID) {
			console.error('ERROR', `通过 Email 检查用户是否已开启 2FA 身份验证器失败，未找到 UUID`)
			return { success: false, have2FA: false, message: '通过 Email 检查用户是否已开启 2FA 身份验证器失败，未找到 UUID' }
		}

		const authenticatorType = userAuthResult.result[0].authenticatorType
		if (authenticatorType === 'totp') {
			const { collectionName: userTotpAuthenticatorCollectionName, schemaInstance: userTotpAuthenticatorSchemaInstance } = UserTotpAuthenticatorSchema
			type UserTotpAuthenticator = InferSchemaType<typeof userTotpAuthenticatorSchemaInstance>

			const userTotpAuthenticatorWhere: QueryType<UserTotpAuthenticator> = { UUID, enabled: true }
			const userTotpAuthenticatorSelect: SelectType<UserTotpAuthenticator> = { createDateTime: 1 }

			const userTotpAuthenticatorResult = await selectDataFromMongoDB<UserTotpAuthenticator>(userTotpAuthenticatorWhere, userTotpAuthenticatorSelect, userTotpAuthenticatorSchemaInstance, userTotpAuthenticatorCollectionName)
			const totpCreationDateTime = userTotpAuthenticatorResult?.result?.[0].createDateTime

			return { success: true, have2FA: true, type: authenticatorType, totpCreationDateTime, message: '用户已开启 TOTP 2FA' }
		} else if (authenticatorType === 'email') {
			return { success: true, have2FA: true, type: authenticatorType, message: '用户已开启 Email 2FA' }
		} else {
			return { success: true, have2FA: false, message: '用户未开启 2FA' }
		}
	} catch (error) {
		console.error('通过 Email 检查用户是否已开启 2FA 身份验证器时出错，未知错误', error)
		return { success: false, have2FA: false, message: '通过 Email 检查用户是否已开启 2FA 身份验证器时出错，未知错误' }
	}
}

/**
 * 通过 UUID 检查用户是否已开启 2FA 身份验证器
 * @param uuid 用户的 UUID
 * @param token 用户的 token
 * @returns 通过 UUID 检查用户是否已开启 2FA 身份验证器的请求响应
 */
export const checkUserHave2FAByUUIDService = async (uuid: string, token: string): Promise<CheckUserHave2FAResponseDto> => {
	try {
		if (!await checkUserTokenByUUID(uuid, token)) {
			console.error('ERROR', `通过 UUID 检查用户是否已开启 2FA 身份验证器失败，非法用户`)
			return { success: false, have2FA: false, message: '通过 UUID 检查用户是否已开启 2FA 身份验证器失败，非法用户' }
		}

		const { collectionName, schemaInstance } = UserAuthSchema
		type UserAuth = InferSchemaType<typeof schemaInstance>

		const userAuthWhere: QueryType<UserAuth> = { UUID: uuid }
		const userAuthSelect: SelectType<UserAuth> = { authenticatorType: 1 }

		const userAuthResult = await selectDataFromMongoDB<UserAuth>(userAuthWhere, userAuthSelect, schemaInstance, collectionName)
		if (!userAuthResult?.result || userAuthResult.result?.length !== 1) {
			console.error('ERROR', `通过 UUID 检查用户是否已开启 2FA 身份验证器失败，未找到用户数据`)
			return { success: false, have2FA: false, message: '通过 UUID 检查用户是否已开启 2FA 身份验证器失败，未找到用户数据' }
		}

		const authenticatorType = userAuthResult.result[0].authenticatorType
		if (authenticatorType === 'totp') {
			const { collectionName: userTotpAuthenticatorCollectionName, schemaInstance: userTotpAuthenticatorSchemaInstance } = UserTotpAuthenticatorSchema
			type UserTotpAuthenticator = InferSchemaType<typeof userTotpAuthenticatorSchemaInstance>

			const userTotpAuthenticatorWhere: QueryType<UserTotpAuthenticator> = { UUID: uuid, enabled: true }
			const userTotpAuthenticatorSelect: SelectType<UserTotpAuthenticator> = { createDateTime: 1 }

			const userTotpAuthenticatorResult = await selectDataFromMongoDB<UserTotpAuthenticator>(userTotpAuthenticatorWhere, userTotpAuthenticatorSelect, userTotpAuthenticatorSchemaInstance, userTotpAuthenticatorCollectionName)
			const totpCreationDateTime = userTotpAuthenticatorResult?.result?.[0].createDateTime

			return { success: true, have2FA: true, type: authenticatorType, totpCreationDateTime, message: '用户已开启 TOTP 2FA' }
		} else if (authenticatorType === 'email') {
			return { success: true, have2FA: true, type: authenticatorType, message: '用户已开启 Email 2FA' }
		} else {
			return { success: true, have2FA: false, message: '用户未开启 2FA' }
		}
	} catch (error) {
		console.error('通过 UUID 检查用户是否已开启 2FA 身份验证器时出错，未知错误', error)
		return { success: false, have2FA: false, message: '通过 UUID 检查用户是否已开启 2FA 身份验证器时出错，未知错误' }
	}
}

/**
 * 校验用户注册信息
 * @param userRegistrationRequest
 * @returns boolean 如果合法则返回 true
 */
const checkUserRegistrationData = (userRegistrationRequest: UserRegistrationRequestDto): boolean => {
	// TODO // WARN 这里可能需要更安全的校验机制
	return (
		true
		&& !!userRegistrationRequest.passwordHash && !!userRegistrationRequest.email && !isInvalidEmail(userRegistrationRequest.email)
		&& !!userRegistrationRequest.verificationCode
		&& !!userRegistrationRequest.username
	)
}

/**
 * 用户邮箱是否存在验证的请求参数的非空验证
 * @param userEmailExistsCheckRequest
 * @returns boolean 合法则返回 true
 */
const checkUserEmailExistsCheckRequest = (userEmailExistsCheckRequest: UserEmailExistsCheckRequestDto): boolean => {
	// TODO // WARN 这里可能需要更安全的校验机制
	return (!!userEmailExistsCheckRequest.email && !isInvalidEmail(userEmailExistsCheckRequest.email))
}

/**
 * 用户登录的请求参数的校验
 * @param userExistsCheckRequest
 * @returns boolean 合法则返回 true
 */
const checkUserLoginRequest = (userLoginRequest: UserLoginRequestDto): boolean => {
	// TODO // WARN 这里可能需要更安全的校验机制
	return (!!userLoginRequest.email && !isInvalidEmail(userLoginRequest.email) && !!userLoginRequest.passwordHash)
}

/**
 * 用户修改邮箱的请求参数的非空验证
 * @param updateUserEmailRequest
 * @returns boolean 合法则返回 true
 */
const checkUpdateUserEmailRequest = (updateUserEmailRequest: UpdateUserEmailRequestDto): boolean => {
	// TODO // WARN 这里可能需要更安全的校验机制
	return (
		updateUserEmailRequest.uid !== null && updateUserEmailRequest.uid !== undefined
		&& !!updateUserEmailRequest.oldEmail && !isInvalidEmail(updateUserEmailRequest.oldEmail)
		&& !!updateUserEmailRequest.newEmail && !isInvalidEmail(updateUserEmailRequest.newEmail)
		&& !!updateUserEmailRequest.passwordHash
		&& !!updateUserEmailRequest.verificationCode
	)
}

// WARN // TODO 或许这些数据放到环境变量里更好？
const ALLOWED_ACCOUNT_TYPE = [
	'X', // Twitter → X
	'qq',
	'wechat',
	'bili', // 哔哩哔哩
	'niconico',
	'youtube',
	'otomadwiki', // 音 MAD 维基
	'weibo', // 新浪微博
	'NECM', // 网易云音乐
	'discord',
	'telegram',
	'midishow',
	'linkedin',
	'facebook',
	'ins', // Instagram
	'douyin', // 抖音
	'tiktok', // TikTok
	'pixiv',
	'coub',
	'github',
]

/**
 * 检查更新或创建用户信息的请求参数
 * @param updateOrCreateUserInfoRequest 更新或创建用户信息的请求参数
 * @returns 检查结果，合法返回 true，不合法返回 false
 */
const checkUpdateOrCreateUserInfoRequest = (updateOrCreateUserInfoRequest: UpdateOrCreateUserInfoRequestDto): boolean => {
	// TODO 也许我们应该在未来为其添加更多验证以避免可能的注入风险

	if (!updateOrCreateUserInfoRequest || isEmptyObject(updateOrCreateUserInfoRequest)) {
		return false
	}

	if (updateOrCreateUserInfoRequest?.userLinkAccounts?.some(account => !ALLOWED_ACCOUNT_TYPE.includes(account.accountType))) {
		return false
	}

	return true
}

/**
 * 检查更新或创建用户设置时的请求参数
 * @param updateOrCreateUserSettingsRequest 更新或创建用户设置时的请求参数
 * @returns 检查结果，合法返回 true，不合法返回 false
 */
const checkUpdateOrCreateUserSettingsRequest = (updateOrCreateUserSettingsRequest: UpdateOrCreateUserSettingsRequestDto): boolean => {
	// TODO 也许我们应该在未来为其添加更多验证以避免可能的注入风险

	if (!updateOrCreateUserSettingsRequest || isEmptyObject(updateOrCreateUserSettingsRequest)) {
		return false
	}

	if (updateOrCreateUserSettingsRequest?.userLinkAccountsPrivacySetting?.some(account => !ALLOWED_ACCOUNT_TYPE.includes(account.accountType))) {
		return false
	}

	return true
}

/**
 * 检查请求发送验证码的请求参数
 * @param requestSendVerificationCodeRequest 请求发送验证码的请求参数
 * @returns 检查结果，合法返回 true，不合法返回 false
 */
const checkRequestSendVerificationCodeRequest = (requestSendVerificationCodeRequest: RequestSendVerificationCodeRequestDto): boolean => {
	return (!isInvalidEmail(requestSendVerificationCodeRequest.email))
}

/**
 * 检查使用邀请码注册的参数
 * @param useInvitationCodeDto 使用邀请码注册的参数
 * @returns 检查结果，合法返回 true，不合法返回 false
 */
const checkUseInvitationCodeDto = (useInvitationCodeDto: UseInvitationCodeDto): boolean => {
	return (
		useInvitationCodeDto.registrantUid !== null && useInvitationCodeDto.registrantUid !== undefined
		&& !!useInvitationCodeDto.invitationCode
	)
}

/**
 * 检查检查一个邀请码是否可用的请求载荷
 * @param checkInvitationCodeRequestDto 检查一个邀请码是否可用的请求载荷
 * @returns 检查结果，合法返回 true，不合法返回 false
 */
const checkCheckInvitationCodeRequestDto = (checkInvitationCodeRequestDto: CheckInvitationCodeRequestDto): boolean => {
	const invitationCodeRegex = /^KIRA-[A-Z0-9]{4}-[A-Z0-9]{4}$/
	return (!!checkInvitationCodeRequestDto.invitationCode && invitationCodeRegex.test(checkInvitationCodeRequestDto.invitationCode))
}

/**
 * 验证请求发送修改邮箱的邮箱验证码的请求载荷
 * @param requestSendChangeEmailVerificationCodeRequest 请求发送修改邮箱的邮箱验证码的请求载荷
 * @returns 检查结果，合法返回 true，不合法返回 false
 */
const checkRequestSendChangeEmailVerificationCodeRequest = (requestSendChangeEmailVerificationCodeRequest: RequestSendChangeEmailVerificationCodeRequestDto): boolean => {
	requestSendChangeEmailVerificationCodeRequest // TODO
	return true
}

/**
 * 验证请求发送修改密码的邮箱验证码的请求载荷
 * @param requestSendChangePasswordVerificationCodeRequest 请求发送修改密码的邮箱验证码的请求载荷
 * @returns 检查结果，合法返回 true，不合法返回 false
 */
const checkRequestSendChangePasswordVerificationCodeRequest = (requestSendChangePasswordVerificationCodeRequest: RequestSendChangePasswordVerificationCodeRequestDto): boolean => {
	requestSendChangePasswordVerificationCodeRequest // TODO
	return true
}

/**
 * 验证修改密码的请求载荷
 * @param updateUserPasswordRequest 修改密码的请求载荷
 * @returns 检查结果，合法返回 true，不合法返回 false
 */
const checkUpdateUserPasswordRequest = (updateUserPasswordRequest: UpdateUserPasswordRequestDto): boolean => {
	return (
		true
		&& !!updateUserPasswordRequest.newPasswordHash
		&& !!updateUserPasswordRequest.oldPasswordHash
		&& !!updateUserPasswordRequest.verificationCode && updateUserPasswordRequest.verificationCode.length === 6
	)
}

/**
 * 检查检查用户名失败的请求载荷
 * @param checkUsernameRequest 检查用户名失败的请求载荷
 * @returns 检查结果，合法返回 true，不合法返回 false
 */
const checkCheckUsernameRequest = (checkUsernameRequest: CheckUsernameRequestDto): boolean => {
	return (!!checkUsernameRequest.username && checkUsernameRequest.username?.length <= 200 && checkUsernameRequest.username?.length > 0)
}

/**
 * 检查封禁用户的请求载荷
 * @param blockUserByUIDRequest 封禁用户的请求载荷
 * @returns 检查结果，合法返回 true，不合法返回 false
 */
const checkBlockUserByUIDRequest = (blockUserByUIDRequest: BlockUserByUIDRequestDto): boolean => {
	return (blockUserByUIDRequest.criminalUid !== null && blockUserByUIDRequest.criminalUid !== undefined)
}

/**
 * 检查重新激活用户的请求载荷
 * @param blockUserByUIDRequest 重新激活用户的请求载荷
 * @returns 检查结果，合法返回 true，不合法返回 false
 */
const checkReactivateUserByUIDRequest = (reactivateUserByUIDRequest: ReactivateUserByUIDRequestDto): boolean => {
	return (reactivateUserByUIDRequest.uid !== null && reactivateUserByUIDRequest.uid !== undefined)
}

/**
 * 检查管理员获取用户信息的请求载荷
 * @param adminGetUserInfoRequest 管理员获取用户信息的请求载荷
 * @returns 检查结果，合法返回 true，不合法返回 false
 */
const checkAdminGetUserInfoRequest = (adminGetUserInfoRequest: AdminGetUserInfoRequestDto): boolean => {
	return (
		adminGetUserInfoRequest.isOnlyShowUserInfoUpdatedAfterReview !== undefined && adminGetUserInfoRequest.isOnlyShowUserInfoUpdatedAfterReview !== null
		&& !!adminGetUserInfoRequest.pagination && adminGetUserInfoRequest.pagination.page > 0 && adminGetUserInfoRequest.pagination.pageSize > 0
	)
}

/**
 * 检查管理员通过用户信息审核的请求载荷
 * @param approveUserInfoRequest 管理员通过用户信息审核的请求载荷
 * @returns 检查结果，合法返回 true，不合法返回 false
 */
const checkApproveUserInfoRequest = (approveUserInfoRequest: ApproveUserInfoRequestDto): boolean => {
	return (!!approveUserInfoRequest.UUID)
}

/**
 * 检查管理员清空某个用户的信息的请求载荷
 * @param adminClearUserInfoRequest 管理员清空某个用户的信息的请求载荷
 * @returns 检查结果，合法返回 true，不合法返回 false
 */
const checkAdminClearUserInfoRequest = (adminClearUserInfoRequest: AdminClearUserInfoRequestDto): boolean => {
	return (
		adminClearUserInfoRequest.uid !== undefined && adminClearUserInfoRequest.uid !== null && typeof adminClearUserInfoRequest.uid === 'number' && adminClearUserInfoRequest.uid > 0
	)
}

/**
 * 检查通过恢复码删除用户 2FA 的参数
 * @param deleteAuthenticatorByRecoveryCodeData 通过恢复码删除用户 2FA 的参数
 * @returns 检查结果，合法返回 true，不合法返回 false
 */
const checkDeleteTotpAuthenticatorByRecoveryCodeData = (deleteTotpAuthenticatorByRecoveryCodeData: DeleteTotpAuthenticatorByRecoveryCodeParametersDto): boolean => {
	return (!!deleteTotpAuthenticatorByRecoveryCodeData.email && !!deleteTotpAuthenticatorByRecoveryCodeData.recoveryCodeHash)
}

/**
 * 检查已登录用户通过密码和 TOTP 验证码删除身份验证器的请求载荷
 * @param deleteAuthenticatorByTotpVerificationCodeRequest 已登录用户通过密码和 TOTP 验证码删除身份验证器的请求载荷
 * @returns 检查结果，合法返回 true，不合法返回 false
 */
const checkDeleteTotpAuthenticatorByTotpVerificationCodeRequest = (deleteTotpAuthenticatorByTotpVerificationCodeRequest: DeleteTotpAuthenticatorByTotpVerificationCodeRequestDto): boolean => {
	return (!!deleteTotpAuthenticatorByTotpVerificationCodeRequest.clientOtp && !!deleteTotpAuthenticatorByTotpVerificationCodeRequest.passwordHash)
}

/**
 * 检查用户发送 Email 身份验证器验证邮件的请求载荷
 * @param sendDeleteTotpAuthenticatorByEmailVerificationCodeRequest 用户发送 Email 身份验证器验证邮件的请求载荷
 * @returns 检查结果，合法返回 true，不合法返回 false
 */
const checkSendUserEmailAuthenticatorVerificationCodeRequest = (sendUserEmailAuthenticatorVerificationCodeRequest: SendUserEmailAuthenticatorVerificationCodeRequestDto): boolean => {
	return (!!sendUserEmailAuthenticatorVerificationCodeRequest.email && !!sendUserEmailAuthenticatorVerificationCodeRequest.passwordHash)
}

/**
 * 检查用户发送删除 Email 身份验证器验证邮件的请求载荷
 * @param sendDeleteTotpAuthenticatorByEmailVerificationCodeRequest 用户发送删除 Email 身份验证器验证邮件的请求载荷
 * @returns 检查结果，合法返回 true，不合法返回 false
 */
const checkSendDeleteUserEmailAuthenticatorVerificationCodeRequest = (sendDeleteUserEmailAuthenticatorVerificationCodeRequest: SendDeleteUserEmailAuthenticatorVerificationCodeRequestDto): boolean => {
	// TODO: 该请求接口允许为空
	return true
}

/**
 * 检查用户删除 Email 2FA 的请求载荷
 * @param deleteUserEmailAuthenticatorRequest 用户删除 Email 2FA 的请求载荷
 * @returns 检查结果，合法返回 true，不合法返回 false
 */
const checkDeleteUserEmailAuthenticatorRequest = (deleteUserEmailAuthenticatorRequest: DeleteUserEmailAuthenticatorRequestDto): boolean => {
	return (
		!!deleteUserEmailAuthenticatorRequest.passwordHash
		&& !!deleteUserEmailAuthenticatorRequest.verificationCode
	)
}

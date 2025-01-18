import { InferSchemaType } from "mongoose";
import { FOLLOWING_TYPE, FollowingUploaderRequestDto, FollowingUploaderResponseDto, UnfollowingUploaderRequestDto, UnfollowingUploaderResponseDto } from "../controller/FeedControllerDto.js";
import { FollowingSchema, UnfollowingSchema } from "../dbPool/schema/FeedSchema.js";
import { checkUserExistsByUuidService, checkUserRoleByUUIDService, checkUserTokenByUuidService } from "./UserService.js";
import { QueryType, SelectType } from "../dbPool/DbClusterPoolTypes.js";
import { deleteDataFromMongoDB, insertData2MongoDB, selectDataFromMongoDB } from "../dbPool/DbClusterPool.js";
import { abortAndEndSession, commitAndEndSession, createAndStartSession } from "../common/MongoDBSessionTool.js";

/**
 * 用户关注一个创作者
 * @param followingUploaderRequest 用户关注一个创作者的请求载荷
 * @param uuid 用户的 UUID
 * @param token 用户的 token
 * @returns 用户关注一个创作者的请求响应
 */
export const followingUploaderService = async (followingUploaderRequest: FollowingUploaderRequestDto, uuid: string, token: string): Promise<FollowingUploaderResponseDto> => {
	try {
		const now = new Date().getTime()
		const followerUuid = uuid
		const { followingUuid } = followingUploaderRequest

		if (followerUuid === followingUuid) {
			console.error('ERROR', '关注用户失败：不能自己关注自己。')
			return { success: false, message: '关注用户失败：不能自己关注自己。' }
		}

		if (!(await checkUserTokenByUuidService(followerUuid, token)).success) {
			console.error('ERROR', '关注用户失败：非法用户。')
			return { success: false, message: '关注用户失败，非法用户' }
		}

		const checkFollowingUuidResult = await checkUserExistsByUuidService({ uuid: followingUuid })
		if (!checkFollowingUuidResult.success || (checkFollowingUuidResult.success && !checkFollowingUuidResult.exists)) {
			console.error('ERROR', '关注用户失败，被关注用户不存在。')
			return { success: false, message: '关注用户失败，被关注用户不存在。' }
		}

		if (await checkUserRoleByUUIDService(followerUuid, 'blocked')) {
			console.error('ERROR', '关注用户失败，发起关注用户已封禁')
			return { success: false, message: '关注用户失败，发起关注的用户已封禁' }
		}

		if (await checkUserRoleByUUIDService(followingUuid, 'blocked')) {
			console.error('ERROR', '关注用户失败，被关注用户已封禁')
			return { success: false, message: '关注用户失败，被关注用户已封禁' }
		}

		const { collectionName: followingSchemaCollectionName, schemaInstance: followingSchemaInstance } = FollowingSchema
		type Following = InferSchemaType<typeof followingSchemaInstance>
		const followingData: Following = {
			followerUuid,
			followingUuid,
			followingType: FOLLOWING_TYPE.uploader,
			isFavourity: false,
			followingEditDateTime: now,
			followingCreateTime: now,
		}

		const insertFollowingDataResult = await insertData2MongoDB<Following>(followingData, followingSchemaInstance, followingSchemaCollectionName)

		if (!insertFollowingDataResult.success) {
			console.error('ERROR', '关注用户失败，插入数据失败。')
			return { success: false, message: '关注用户失败，插入数据失败。' }
		}

		return { success: true, message: '关注用户成功！' }
	} catch (error) {
		console.error('ERROR', '关注用户时出错：未知原因。', error)
		return { success: false, message: '关注用户时出错：未知原因。' }
	}
}

/**
 * 用户取消关注一个创作者
 * @param followingUploaderRequest 用户取消关注一个创作者的请求载荷
 * @param uuid 用户的 UUID
 * @param token 用户的 token
 * @returns 用户取消关注一个创作者的请求响应
 */
export const unfollowingUploaderService = async (unfollowingUploaderRequest: UnfollowingUploaderRequestDto, uuid: string, token: string): Promise<UnfollowingUploaderResponseDto> => {
	try {
		const now = new Date().getTime()
		const followerUuid = uuid
		const { unfollowingUuid } = unfollowingUploaderRequest

		if (followerUuid === unfollowingUuid) {
			console.error('ERROR', '取消关注用户失败：不能取消关注自己。')
			return { success: false, message: '取消关注用户失败：不能取消关注自己。' }
		}

		if (!(await checkUserTokenByUuidService(followerUuid, token)).success) {
			console.error('ERROR', '取消关注用户失败：非法用户。')
			return { success: false, message: '取消关注用户失败，非法用户' }
		}

		const checkFollowingUuidResult = await checkUserExistsByUuidService({ uuid: unfollowingUuid })
		if (!checkFollowingUuidResult.success || (checkFollowingUuidResult.success && !checkFollowingUuidResult.exists)) {
			console.error('ERROR', '取消关注用户失败，被关注用户不存在。')
			return { success: false, message: '取消关注用户失败，被关注用户不存在。' }
		}

		if (await checkUserRoleByUUIDService(followerUuid, 'blocked')) {
			console.error('ERROR', '取消关注用户失败，发起取消关注的用户已封禁')
			return { success: false, message: '取消关注用户失败，发起取消关注的用户已封禁' }
		}

		const { collectionName: followingSchemaCollectionName, schemaInstance: followingSchemaInstance } = FollowingSchema
		const { collectionName: unfollowingSchemaCollectionName, schemaInstance: unfollowingSchemaInstance } = UnfollowingSchema
		type Following = InferSchemaType<typeof followingSchemaInstance>
		type Unfollowing = InferSchemaType<typeof unfollowingSchemaInstance>

		const followingWhere: QueryType<Following> = {
			followerUuid,
			followingUuid: unfollowingUuid,
		}
		const followingSelect: SelectType<Following> = {
			followerUuid: 1,
			followingUuid: 1,
			followingType: 1,
			isFavourity: 1,
			followingEditDateTime: 1,
			followingCreateTime: 1,
		}

		const session = await createAndStartSession()
		
		const selectUnfollowingDataResult = await selectDataFromMongoDB<Following>(followingWhere, followingSelect, followingSchemaInstance, followingSchemaCollectionName, { session })
		const selectUnfollowingData = selectUnfollowingDataResult?.result?.[0]

		if (!selectUnfollowingDataResult.success && selectUnfollowingDataResult.result.length !== 1 && selectUnfollowingData) {
			await abortAndEndSession(session)
			console.error('ERROR', '取消关注用户失败，读取关注数据失败。')
			return { success: false, message: '取消关注用户失败，读取关注数据失败。' }
		}

		const unfollowingData: Unfollowing = {
			...selectUnfollowingData,
			unfollowingReasonType: 'normal',
			unfollowingDateTime: now,
			unfollowingEditDateTime: now,
			unfollowingCreateTime: now,
		}
		
		const insertUnfollowingDataResult = await insertData2MongoDB<Unfollowing>(unfollowingData, unfollowingSchemaInstance, unfollowingSchemaCollectionName, { session })

		if (!insertUnfollowingDataResult.success) {
			await abortAndEndSession(session)
			console.error('ERROR', '取消关注用户失败，记录处理失败。')
			return { success: false, message: '取消关注用户失败，记录处理失败。' }
		}

		const deleteFollowingDataResult = await deleteDataFromMongoDB<Following>(followingWhere, followingSchemaInstance, followingSchemaCollectionName, { session })
		
		if (!deleteFollowingDataResult.success) {
			await abortAndEndSession(session)
			console.error('ERROR', '取消关注用户失败，删除关注记录失败。')
			return { success: false, message: '取消关注用户失败，删除关注记录失败。' }
		}

		await commitAndEndSession(session)
		return { success: true, message: '取消关注用户成功！' }
	} catch (error) {
		console.error('ERROR', '取消关注用户时出错：未知原因。', error)
		return { success: false, message: '取消关注用户时出错：未知原因。' }
	}
}

import { InferSchemaType } from "mongoose";
import { FeedingUploaderRequestDto, FeedingUploaderResponseDto, UnfeedingUploaderRequestDto, UnfeedingUploaderResponseDto } from "../controller/FeedControllerDto.js";
import { FeedSchema, UnfeedSchema } from "../dbPool/schema/FeedSchema.js";
import { checkUserExistsByUuidService, checkUserRoleByUUIDService, checkUserTokenByUuidService } from "./UserService.js";
import { QueryType, SelectType } from "../dbPool/DbClusterPoolTypes.js";
import { deleteDataFromMongoDB, insertData2MongoDB, selectDataFromMongoDB } from "../dbPool/DbClusterPool.js";
import { abortAndEndSession, commitAndEndSession, createAndStartSession } from "../common/MongoDBSessionTool.js";

/**
 * 用户关注一个创作者
 * @param feedingUploaderRequest 用户关注一个创作者的请求载荷
 * @param uuid 用户的 UUID
 * @param token 用户的 token
 * @returns 用户关注一个创作者的请求响应
 */
export const feedingUploaderService = async (feedingUploaderRequest: FeedingUploaderRequestDto, uuid: string, token: string): Promise<FeedingUploaderResponseDto> => {
	try {
		const now = new Date().getTime()
		const followerUuid = uuid
		const { followingUuid } = feedingUploaderRequest

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

		const { collectionName: feedSchemaCollectionName, schemaInstance: feedSchemaInstance } = FeedSchema
		type Feed = InferSchemaType<typeof feedSchemaInstance>
		const feedData: Feed = {
			followerUuid,
			followingUuid,
			feedType: 'uploader',
			isFavourity: false,
			feedingEditDateTime: now,
			feedingCreateTime: now,
		}

		const insertFeedDataResult = await insertData2MongoDB(feedData, feedSchemaInstance, feedSchemaCollectionName)

		if (!insertFeedDataResult.success) {
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
 * @param feedingUploaderRequest 用户取消关注一个创作者的请求载荷
 * @param uuid 用户的 UUID
 * @param token 用户的 token
 * @returns 用户取消关注一个创作者的请求响应
 */
export const unfeedingUploaderService = async (unfeedingUploaderRequest: UnfeedingUploaderRequestDto, uuid: string, token: string): Promise<UnfeedingUploaderResponseDto> => {
	try {
		const now = new Date().getTime()
		const followerUuid = uuid
		const { unfollowingUuid } = unfeedingUploaderRequest

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

		const { collectionName: feedSchemaCollectionName, schemaInstance: feedSchemaInstance } = FeedSchema
		const { collectionName: unfeedSchemaCollectionName, schemaInstance: unfeedSchemaInstance } = UnfeedSchema
		type Feed = InferSchemaType<typeof feedSchemaInstance>
		type Unfeed = InferSchemaType<typeof unfeedSchemaInstance>

		const feedWhere: QueryType<Feed> = {
			followerUuid,
			followingUuid: unfollowingUuid,
		}
		const feedSelect: SelectType<Feed> = {
			followerUuid: 1,
			followingUuid: 1,
			feedType: 1,
			isFavourity: 1,
			feedingEditDateTime: 1,
			feedingCreateTime: 1,
		}

		const session = await createAndStartSession()
		
		const selectUnfeedDataResult = await selectDataFromMongoDB<Feed>(feedWhere, feedSelect, feedSchemaInstance, feedSchemaCollectionName, { session })
		const selectUnfeedData = selectUnfeedDataResult?.result?.[0]

		if (!selectUnfeedDataResult.success && selectUnfeedDataResult.result.length !== 1 && selectUnfeedData) {
			await abortAndEndSession(session)
			console.error('ERROR', '取消关注用户失败，读取关注数据失败。')
			return { success: false, message: '取消关注用户失败，读取关注数据失败。' }
		}

		const unfeedData: Unfeed = {
			...selectUnfeedData,
			unfeedReasonType: 'normal',
			unfollowingDateTime: now,
			unfeedingEditDateTime: now,
			unfeedingCreateTime: now,
		}
		
		const insertUnfeedDataResult = await insertData2MongoDB(unfeedData, unfeedSchemaInstance, unfeedSchemaCollectionName, { session })

		if (!insertUnfeedDataResult.success) {
			await abortAndEndSession(session)
			console.error('ERROR', '取消关注用户失败，记录处理失败。')
			return { success: false, message: '取消关注用户失败，记录处理失败。' }
		}

		const deleteFeedDataResult = await deleteDataFromMongoDB(feedWhere, feedSchemaInstance, feedSchemaCollectionName, { session })
		
		if (!deleteFeedDataResult.success) {
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

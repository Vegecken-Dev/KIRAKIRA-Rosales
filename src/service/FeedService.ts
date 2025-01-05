import { InferSchemaType } from "mongoose";
import { FeedingUploaderRequestDto, FeedingUploaderResponseDto } from "../controller/FeedControllerDto.js";
import { FeedSchema } from "../dbPool/schema/FeedSchema.js";
import { checkUserExistsByUuidService, checkUserRoleByUUIDService, checkUserTokenByUuidService } from "./UserService.js";
import { QueryType } from "../dbPool/DbClusterPoolTypes.js";
import { insertData2MongoDB } from "../dbPool/DbClusterPool.js";

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
			console.error('ERROR', '关注用户失败，用户已封禁')
			return { success: false, message: '关注用户失败，用户已封禁' }
		}

		if (await checkUserRoleByUUIDService(followingUuid, 'blocked')) {
			console.error('ERROR', '关注用户失败，用户已封禁')
			return { success: false, message: '关注用户失败，用户已封禁' }
		}

		const { collectionName: feedSchemaCollectionName, schemaInstance: feedSchemaInstance } = FeedSchema
		type Feed = InferSchemaType<typeof feedSchemaInstance>
		const feedData: Feed = {
			followerUuid,
			followingUuid,
			feedType: 'uploader',
			editDateTime: now,
			createTime: now,
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

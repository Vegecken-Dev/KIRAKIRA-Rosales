import { followingUploaderService, unfollowingUploaderService } from "../service/FeedService.js";
import { koaCtx, koaNext } from "../type/koaTypes.js";
import { FollowingUploaderRequestDto, UnfollowingUploaderRequestDto } from "./FeedControllerDto.js";

/**
 * 用户关注一个创作者
 * @param ctx context
 * @param next context
 * @return 用户关注一个创作者的请求响应
 */
export const followingUploaderController = async (ctx: koaCtx, next: koaNext) => {
	const uuid = ctx.cookies.get('uuid')
	const token = ctx.cookies.get('token')
	const data = ctx.request.body as Partial<FollowingUploaderRequestDto>

	const feedingUploaderRequest: FollowingUploaderRequestDto = {
		followingUid: data.followingUid ?? -1
	}
	
	const feedingUploaderResult = await followingUploaderService(feedingUploaderRequest, uuid, token)
	ctx.body = feedingUploaderResult
	await next()
}

/**
 * 用户取消关注一个创作者
 * @param ctx context
 * @param next context
 * @return 用户取消关注一个创作者的请求响应
 */
export const unfollowingUploaderController = async (ctx: koaCtx, next: koaNext) => {
	const uuid = ctx.cookies.get('uuid')
	const token = ctx.cookies.get('token')
	const data = ctx.request.body as Partial<UnfollowingUploaderRequestDto>

	const unfeedingUploaderRequest: UnfollowingUploaderRequestDto = {
		unfollowingUid: data.unfollowingUid ?? -1
	}
	
	const feedingUploaderResult = await unfollowingUploaderService(unfeedingUploaderRequest, uuid, token)
	ctx.body = feedingUploaderResult
	await next()
}

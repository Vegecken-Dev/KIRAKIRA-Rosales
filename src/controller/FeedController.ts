import { feedingUploaderService, unfeedingUploaderService } from "../service/FeedService.js";
import { koaCtx, koaNext } from "../type/koaTypes.js";
import { FeedingUploaderRequestDto, UnfeedingUploaderRequestDto } from "./FeedControllerDto.js";

/**
 * 用户关注一个创作者
 * @param ctx context
 * @param next context
 * @return 用户关注一个创作者的请求响应
 */
export const feedingUploaderController = async (ctx: koaCtx, next: koaNext) => {
	const uuid = ctx.cookies.get('uuid')
	const token = ctx.cookies.get('token')
	const data = ctx.request.body as Partial<FeedingUploaderRequestDto>

	const feedingUploaderRequest: FeedingUploaderRequestDto = {
		followingUuid: data.followingUuid ?? ""
	}
	
	const feedingUploaderResult = await feedingUploaderService(feedingUploaderRequest, uuid, token)
	ctx.body = feedingUploaderResult
	await next()
}

/**
 * 用户取消关注一个创作者
 * @param ctx context
 * @param next context
 * @return 用户取消关注一个创作者的请求响应
 */
export const unfeedingUploaderController = async (ctx: koaCtx, next: koaNext) => {
	const uuid = ctx.cookies.get('uuid')
	const token = ctx.cookies.get('token')
	const data = ctx.request.body as Partial<UnfeedingUploaderRequestDto>

	const unfeedingUploaderRequest: UnfeedingUploaderRequestDto = {
		unfollowingUuid: data.unfollowingUuid ?? ""
	}
	
	const feedingUploaderResult = await unfeedingUploaderService(unfeedingUploaderRequest, uuid, token)
	ctx.body = feedingUploaderResult
	await next()
}

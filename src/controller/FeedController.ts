import { feedingUploaderService } from "../service/FeedService.js";
import { koaCtx, koaNext } from "../type/koaTypes.js";
import { FeedingUploaderRequestDto } from "./FeedControllerDto.js";

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
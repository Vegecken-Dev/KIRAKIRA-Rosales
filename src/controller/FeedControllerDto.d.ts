/**
 * 用户关注一个创作者的请求载荷
 */
export type FeedingUploaderRequestDto = {
	/** 被关注者 UUID */
	followingUuid: string;
};

/**
 * 用户关注一个创作者的请求响应
 */
export type FeedingUploaderResponseDto = {
	/** 执行结果 */
	success: boolean;
	/** 附加的文本消息 */
	message?: string;
};

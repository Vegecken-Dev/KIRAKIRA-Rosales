/** 关注的类型 */
export enum FOLLOWING_TYPE {
	/** 通过视频页面或者用户页面等页面的关注按钮正常关注 */
	normal = 'normal',
	/** 自动关注 */ // MEME: really?
	auto = 'auto',
	/** 通过活动页面关注 */
	event = 'event',
	/** 通过活动页面自动批量关注 */
	eventAutoBatch = 'eventAutoBatch',
}

/**
 * 用户关注一个创作者的请求载荷
 */
export type FollowingUploaderRequestDto = {
	/** 被关注者 UID */
	followingUid: number;
};

/**
 * 用户关注一个创作者的请求响应
 */
export type FollowingUploaderResponseDto = {
	/** 执行结果 */
	success: boolean;
	/** 附加的文本消息 */
	message?: string;
};

/**
 * 用户取消关注一个创作者的请求载荷
 */
export type UnfollowingUploaderRequestDto = {
	/** 取消关注者 UID */
	unfollowingUid: number;
};

/**
 * 用户取消关注一个创作者的请求响应
 */
export type UnfollowingUploaderResponseDto = {
	/** 执行结果 */
	success: boolean;
	/** 附加的文本消息 */
	message?: string;
};

import { Schema } from 'mongoose'

/**
 * 用户关注数据
 */
class FeedSchemaFactory {
	/** MongoDB Schema */
	schema = {
		/** 关注者 UUID - 非空 */
		followerUuid: { type: String, required: true },
		/** 被关注者 UUID - 非空 */
		followingUuid: { type: String, required: true },
		/** 关注类型 - 非空 */
		feedType: { type: String, required: true },
		/** 是否是特别关心 - 非空 */
		isFavourity: { type: Boolean, required: true },
		/** 系统专用字段-最后编辑时间 - 非空 */
		feedingEditDateTime: { type: Number, required: true },
		/** 系统专用字段-创建时间 - 非空 */
		feedingCreateTime: { type: Number, required: true },
	}
	/** MongoDB 集合名 */
	collectionName = 'feed'
	/** Mongoose Schema 实例 */
	schemaInstance = new Schema(this.schema)
}
export const FeedSchema = new FeedSchemaFactory()

/**
 * 用户取消关注数据
 */
class UnfeedSchemaFactory {
	/** MongoDB Schema */
	schema = {
		/** 原始关注数据，继承自 FeedSchema */
		...FeedSchema.schema,
		/** 取消关注原因类型 - 非空 */
		unfeedReasonType: { type: String, request: true },
		/** 用户取消关注的日期 - 非空 */
		unfollowingDateTime: { type: Number, required: true },
		/** 系统专用字段-最后编辑时间 - 非空 */
		unfeedingEditDateTime: { type: Number, required: true },
		/** 系统专用字段-创建时间 - 非空 */
		unfeedingCreateTime: { type: Number, required: true },
	}
	/** MongoDB 集合名 */
	collectionName = 'feed'
	/** Mongoose Schema 实例 */
	schemaInstance = new Schema(this.schema)
}
export const UnfeedSchema = new UnfeedSchemaFactory()

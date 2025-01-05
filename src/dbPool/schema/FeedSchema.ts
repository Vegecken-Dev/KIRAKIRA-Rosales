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
		/** 系统专用字段-最后编辑时间 - 非空 */
		editDateTime: { type: Number, required: true },
		/** 系统专用字段-创建时间 - 非空 */
		createTime: { type: Number, required: true },
	}
	/** MongoDB 集合名 */
	collectionName = 'feed'
	/** Mongoose Schema 实例 */
	schemaInstance = new Schema(this.schema)
}
export const FeedSchema = new FeedSchemaFactory()

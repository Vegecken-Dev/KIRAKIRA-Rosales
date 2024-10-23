import { ClientSession } from "mongoose"

/**
 * 回滚并结束事务
 * @param session 事务 session
 * @returns 成功回滚并结束事务返回 true，否则返回 false
 */
export const abortAndEndSession = async (session: ClientSession): Promise<boolean> => {
	if (!session) {
		return false
	}

	if (!session.inTransaction()) {
		return false
	}

	await session.abortTransaction()
	session.endSession()
	return true
}

/**
 * 提交并结束事务
 * @param session 事务 session
 * @returns 成功提交并结束事务返回 true，否则返回 false
 */
export const commitSession = async (session: ClientSession): Promise<boolean> => {
	if (!session) {
		return false
	}

	await session.commitTransaction()
	session.endSession()
}

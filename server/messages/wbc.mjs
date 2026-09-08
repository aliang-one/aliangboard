// routes/workbench-conversations.mjs 的用户可见消息（zh 与原文逐字一致，既有测试断言依赖）
export const TABLE = {
  'wbc.convNotFound': { zh: '对话不存在', en: 'Conversation not found' },
  'wbc.notPaused': { zh: '对话不在待审批状态', en: 'Conversation is not awaiting approval' },
  'wbc.notPausedConcurrent': { zh: '对话不在待审批状态(并发审批已被处理)', en: 'Conversation is not awaiting approval (concurrent approval already handled)' },
  'wbc.projectNotFound': { zh: '项目不存在', en: 'Project not found' },
  'wbc.noProjectAccess': { zh: '无权访问该项目', en: 'No access to this project' },
  'wbc.noAccess': { zh: '无权访问', en: 'Access denied' },
  // approval-flow-02(2026-09-07 审计批次三)文案明确化:approve 400 此前被前端当 CAS 竞态
  // 静默吞掉,现横幅直显服务端文案——裸「LLM 未配置」不指路;对齐 api.llmNotConfigured 的
  // 可操作风格。全端点共用(create/messages/regenerate/edit/approve/deny 终态)。
  'wbc.llmNotConfigured': { zh: 'LLM 未配置,无法继续执行(需管理员在「LLM 配置」设置 baseURL/model 后重试)', en: 'LLM is not configured and execution cannot continue (an admin must set baseURL/model in "LLM config", then retry)' },
  'wbc.createFailed': { zh: '创建对话失败', en: 'Failed to create conversation' },
  'wbc.busyNoResume': { zh: '对话运行中/待审批,不能续接', en: 'Conversation is running or awaiting approval; cannot continue' },
  'wbc.messageRequired': { zh: '消息内容不能为空', en: 'Message content is required' },
  'wbc.resumeFailed': { zh: '续接失败', en: 'Failed to continue conversation' },
  'wbc.busyNoRegen': { zh: '对话运行中,不能重新生成', en: 'Conversation is running; cannot regenerate' },
  'wbc.noRegenTarget': { zh: '没有可重新生成的回复', en: 'No reply to regenerate' },
  'wbc.regenFailed': { zh: '重新生成失败', en: 'Failed to regenerate' },
  'wbc.deleteFailed': { zh: '删除失败', en: 'Failed to delete' },
  'wbc.titleRequired': { zh: 'title 不能为空', en: 'title is required' },
  // cancel-races-06(2026-09-07 审计批次三):approve/deny 的 CAS 后留痕/构造抛错兜底文案
  'wbc.approveFailed': { zh: '审批失败', en: 'Failed to approve' },
  'wbc.denyFailed': { zh: '拒绝失败', en: 'Failed to deny' },
  // conv-lifecycle-07:rename 的 readBody 保码兜底文案(413/400 之外的意外错误)
  'wbc.renameFailed': { zh: '重命名失败', en: 'Failed to rename' },
  'wbc.projectIdRequired': { zh: '缺 projectId', en: 'projectId is required' },
  'wbc.cancelFailed': { zh: '取消失败', en: 'Failed to cancel' },
  'wbc.compactShort': { zh: '对话太短,无需压缩', en: 'Conversation too short to compact' },
  'wbc.compactBusy': { zh: '对话运行中/待审批,不能压缩', en: 'Conversation running/paused, cannot compact' },
  'wbc.compactFailed': { zh: '摘要失败', en: 'Summarization failed' },
  // conv-lifecycle-01:compact 的 LLM await 窗口内对话被并发变更(并发摘要/截断推进了水位),
  // 条件写拒绝、本次未落库——重试即可(前端 compact modal 收非 2xx 保持打开供重试)。
  'wbc.compactRaced': { zh: '对话在压缩期间发生了变化,本次未落库,请重试', en: 'Conversation changed during compaction; nothing was written. Please retry' },
  'wbc.editContentRequired': { zh: '消息内容不能为空', en: 'Message content required' },
  'wbc.editAnchorInvalid': { zh: '编辑目标无效:须为本对话的 user 消息', en: 'Invalid edit target: must be a user message in this conversation' },
  'wbc.editFailed': { zh: '编辑重发失败', en: 'Edit-resend failed' },
  // 对话限额(F6,2026-09-07 审计):429 文案必须含当前生效上限值(前端 errorBanner 直显服务端 message)
  'wbc.convRunningLimit': { zh: '并发运行中的对话已达上限({limit}),请等待运行结束、取消部分对话,或在 AI 配置中调高上限', en: 'Concurrent running conversations have reached the limit ({limit}). Wait for runs to finish, cancel some conversations, or raise the limit in AI config' },
  'wbc.convProjectLimit': { zh: '该项目对话总数已达上限({limit}),请删除旧对话,或在 AI 配置中调高上限', en: 'This project has reached its conversation quota ({limit}). Delete old conversations, or raise the limit in AI config' },
  // refs 归一门(refs-injection-02,2026-09-07 审计批次二):400 文案带上限值,与限额文案同款
  // 「用户可自证门值」口径;畸形/超字节为固定文案(无数值可带)。
  'wbc.refsTooMany': { zh: '引用数量超过上限({limit}),请删减后重试', en: 'Too many references (limit {limit}). Remove some and retry' },
  'wbc.refsInvalid': { zh: '引用格式无效:须为对象数组,kind/namespace/name 均为字符串', en: 'Invalid references: expected an array of objects with string kind/namespace/name' },
  'wbc.refsTooLarge': { zh: '引用总大小超过上限({limitKB}KB)', en: 'References exceed the total size limit ({limitKB}KB)' },
  // gap3-02(2026-09-07 审计批次三):审批集群戳门——裁决快照锚定创建时集群,执行前比对
  // 当下绑定不一致即拒(同时是换绑协调 gap3-03 失效审批的用户可见文案)。
  'wbc.approvalClusterChanged': { zh: '集群已换绑,请重新发起', en: 'The project cluster has changed; please start a new request' },
}

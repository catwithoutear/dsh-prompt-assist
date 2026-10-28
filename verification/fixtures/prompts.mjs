/** Deterministic model output shared by the mock provider and the Playwright spec. */

export const CHAT_PROMPT = '请回复一句测试消息';
export const CHAT_REPLY = '这是测试回复：容器内的 DSH Web 已正常渲染。';

export const PREDICT_TEXT = '帮我确认一下容器内截图里的输入框布局是否正常。';

export const CONTINUATION_DRAFT = '请帮我检查一下';
export const CONTINUATION_TEXT = '并确认一下预览的位置。';

export const OPTIMIZE_DRAFT = '帮我检查一下容器内的界面。';
export const OPTIMIZE_TEXT = '请检查容器内截图中的输入框和按钮布局，确认没有重叠。';
export const OPTIMIZE_OUTPUT = `MODE: replace\n${OPTIMIZE_TEXT}`;

export const QUESTIONS_DRAFT = '帮我优化一下那个东西。';
export const QUESTIONS_TEXT = '1. “那个东西”具体指哪个文件或功能？\n2. 优化范围是整段草稿还是其中一句？';
export const QUESTIONS_OUTPUT = `MODE: questions\n${QUESTIONS_TEXT}`;

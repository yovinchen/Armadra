import type { MessageModule } from "./index";
export const gitMessage: MessageModule = {
  "zh-CN": {
    "gitMessage.title": "AI 提交信息草稿",
    "gitMessage.provider": "生成服务",
    "gitMessage.language": "草稿语言",
    "gitMessage.language.zh": "简体中文",
    "gitMessage.language.en": "英文",
    "gitMessage.conventional": "使用 Conventional Commits 主题",
    "gitMessage.optionsNote":
      "两项只影响写给生成服务的指令；读取范围、文件排除与敏感行处理不变。",
    "gitMessage.generate": "生成草稿",
    "gitMessage.generating": "正在生成草稿…",
    "gitMessage.fill": "填入提交框",
    "gitMessage.checking": "正在核对暂存区…",
    "gitMessage.preview": "草稿预览",
    "gitMessage.reload": "重新检查",
    "gitMessage.note":
      "点击生成会将经过文件排除与敏感行处理的暂存文本发送给 Claude API；仍请检查暂存内容。结果仅供预览，不会自动提交。",
    "gitMessage.credentials":
      "隔离模式依赖运行服务的 ANTHROPIC_API_KEY，不使用 Claude 订阅登录，也不会保存密钥。",
    "gitMessage.reason.notInstalled": "未安装 Claude CLI。",
    "gitMessage.reason.unsupportedCli":
      "当前 CLI 不具备所需隔离选项；Windows 需使用原生可执行程序。",
    "gitMessage.reason.missingCredentials":
      "运行服务尚未设置 ANTHROPIC_API_KEY。",
    "gitMessage.reason.unsupportedEndpoint":
      "当前配置使用自定义或第三方服务地址，此隔离适配暂不支持。",
    "gitMessage.unavailable": "当前没有可用的隔离生成服务。",
    "gitMessage.empty": "没有可用于生成的非敏感暂存文本。",
    "gitMessage.included": "包含的文件",
    "gitMessage.excluded": "排除的文件",
    "gitMessage.truncated": "输入已截断，草稿可能无法覆盖全部修改。",
    "gitMessage.redacted": "检测到的敏感行已隐藏。",
    "gitMessage.edited":
      "提交框已被人工修改，草稿不会覆盖这些内容。请保留当前文本或重新生成。",
    "gitMessage.stale": "HEAD 或暂存内容已变化，请重新生成草稿。",
    "gitMessage.failed": "无法生成草稿，请检查服务配置后重试。",
    "gitMessage.sourceFailed": "无法读取当前暂存内容。",
    "gitMessage.draftOnly": "仅填入提交框；提交仍由你手动触发。",
  },
  en: {
    "gitMessage.title": "AI commit-message draft",
    "gitMessage.provider": "Provider",
    "gitMessage.language": "Draft language",
    "gitMessage.language.zh": "Simplified Chinese",
    "gitMessage.language.en": "English",
    "gitMessage.conventional": "Use a Conventional Commits subject",
    "gitMessage.optionsNote":
      "Both options only change the instruction sent to the provider. What is read, which files are excluded and how sensitive lines are handled stay the same.",
    "gitMessage.generate": "Generate draft",
    "gitMessage.generating": "Generating draft…",
    "gitMessage.fill": "Fill commit message",
    "gitMessage.checking": "Checking staged changes…",
    "gitMessage.preview": "Draft preview",
    "gitMessage.reload": "Check again",
    "gitMessage.note":
      "Generating sends staged text, after file exclusions and sensitive-line filtering, to the Claude API. Review your staged content. Results are previews and never commit automatically.",
    "gitMessage.credentials":
      "Isolated mode needs ANTHROPIC_API_KEY in the running service environment. It does not use the Claude subscription login or save keys.",
    "gitMessage.reason.notInstalled": "Claude CLI is not installed.",
    "gitMessage.reason.unsupportedCli":
      "This CLI lacks the required isolation options. Windows requires a native executable.",
    "gitMessage.reason.missingCredentials":
      "The running service has no ANTHROPIC_API_KEY.",
    "gitMessage.reason.unsupportedEndpoint":
      "Custom or third-party provider endpoints are not supported by this isolated adapter.",
    "gitMessage.unavailable": "No isolated generation provider is available.",
    "gitMessage.empty":
      "No non-sensitive staged text is available to generate from.",
    "gitMessage.included": "Included files",
    "gitMessage.excluded": "Excluded files",
    "gitMessage.truncated":
      "Input was truncated; the draft may not describe every change.",
    "gitMessage.redacted": "Detected sensitive lines were hidden.",
    "gitMessage.edited":
      "The commit field was edited manually. This draft will not overwrite it. Keep the current text or generate again.",
    "gitMessage.stale": "HEAD or staged content changed. Generate a new draft.",
    "gitMessage.failed":
      "Could not generate a draft. Check the provider configuration and try again.",
    "gitMessage.sourceFailed": "Could not read the current staged changes.",
    "gitMessage.draftOnly":
      "Fills the commit field only. You still submit the commit yourself.",
  },
};

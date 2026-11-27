type Change = { title: string; description: string };

interface ReleaseNote {
  date: string;
  title: string;
  added?: Change[];
  improved?: Change[];
  fixed?: Change[];
}

export const releaseNotes: Record<string, ReleaseNote> = {
  "0.1.8": {
    date: "2026-11-27",
    title: "备份下载与排期保护",
    added: [
      { title: "一键下载备份", description: "超级管理员可在设置的「数据备份」中生成并下载经过校验的 ZIP 备份。" },
      { title: "网页上传升级", description: "超级管理员可在「系统升级」上传已签名的源码 ZIP，确认版本后更新，页面显示进度和结果。" },
    ],
    improved: [
      { title: "归档排期保护", description: "归档需求的线段淡化显示，开发人、排期和开发人天只读，行序可在同组拖动调整。" },
      { title: "P0 排期变更确认", description: "休假等操作影响 P0 需求的有效开发人天时，保存前会展示变更前后的值并要求确认。" },
      { title: "需求链接", description: "编辑和预览面板可在新标签页打开 PRD、望岳工单和 BRD 链接。" },
    ],
    fixed: [
      { title: "甘特图右键拖动预览", description: "目标与原排期重叠时，也能看清目标的填充和起止边界。" },
      { title: "悬停提示", description: "提示气泡根据可用宽度展示文本，空间充足时可单行显示。" },
    ],
  },
  "0.1.7": {
    date: "2026-11-26",
    title: "需求页公告与排期调整",
    added: [
      { title: "需求页公告", description: "超级管理员可发布带文字链接的公告。需求页实时显示，内容超出宽度时滚动播报，用户可关闭公告。" },
    ],
    improved: [
      { title: "删除需求联动排期", description: "管理员删除已排期需求时，可选择保留原排期或前移同一开发人的后续排期。前移保留并行、HOLD、休假、加班和补位。" },
      { title: "需求页顶部布局", description: "搜索框展开时，公告随可用空间调整宽度，新增需求按钮保持固定位置。" },
      { title: "甘特图日期分隔", description: "悬停排期线段时，仅在日期格之间显示细竖虚线。" },
      { title: "需求编辑面板", description: "保存和取消按钮移到面板底部左侧。" },
    ],
  },
  "0.1.6": {
    date: "2026-11-24",
    title: "设置页新增更新日志",
    added: [
      { title: "按版本查看更新", description: "设置页新增时间轴。同一版本发布多次时，新增、优化和修复会汇总到同一个节点。" },
    ],
    improved: [
      { title: "在线成员头像配色", description: "文字头像按姓名末字的拼音首字母固定选色，方便区分在线成员。" },
    ],
    fixed: [
      { title: "甘特图单击光标", description: "单击排期格时不再出现闪烁的文本光标。" },
    ],
  },
  "0.1.5": {
    date: "2026-11-19",
    title: "协作排期与需求管理",
    added: [
      { title: "需求数据接口", description: "提供一个只读接口，汇总需求池、归档、人力排期及补位信息。" },
      { title: "协作与优先级", description: "甘特图排序实时同步，支持跨组拖动更换开发人。需求池可标记需求方优先级，在甘特图悬停需求名称即可查看序号。" },
      { title: "撤回、重做与快速复制", description: "需求操作支持快捷键撤回和重做。三个子页可右键复制需求名、PRD 和望岳地址。" },
    ],
    improved: [
      { title: "P0 交付变动确认", description: "编辑、拖拽或顺排导致 P0 交付日期变动时，先展示受影响的需求和日期。" },
      { title: "操作记录明细", description: "操作记录展示变更字段及修改前后值。" },
      { title: "甘特图可读性", description: "需求名旁显示状态标签和优先级竖线。开发中的排期使用连续波纹，拖动或双击分隔线可调整需求名称列宽。" },
    ],
    fixed: [
      { title: "甘特图归档排期", description: "归档后仍按筛选的时间范围显示排期，默认按可见线段的开始日期排列。" },
      { title: "优先级标注", description: "仅登录用户可操作指定单元格。标记时保留当前行序，方便连续操作。" },
    ],
  },
  "0.1.4": {
    date: "2026-11-19",
    title: "甘特图补位排期",
    added: [
      { title: "补位线段", description: "可在工作日或已标记加班的日期添加补位，关联未归档需求，支持拖动和取消。" },
    ],
    fixed: [
      { title: "补位选择与显示", description: "修正选择面板滚动，统一补位图例和甘特图标记，并对齐线段高度。" },
    ],
  },
  "0.1.3": {
    date: "2026-11-18",
    title: "甘特图拖拽与列宽",
    improved: [
      { title: "需求名称列", description: "可拖动分隔线调整列宽。整个需求名称格支持拖动排序，并显示插入位置。" },
      { title: "排期状态", description: "需求名旁显示 HOLD 标记，开发中动效沿整段排期向右流动。" },
    ],
  },
  "0.1.2": {
    date: "2026-11-18",
    title: "需求排序与甘特图控制",
    added: [
      { title: "多字段排序", description: "需求池和已归档支持全量级联排序与一键重置，默认按进池或归档时间从新到旧排列。" },
    ],
    improved: [
      { title: "甘特图工具", description: "将全部展开和收起移入表头，缩小时可用浮动按钮恢复比例。" },
    ],
  },
  "0.1.1": {
    date: "2026-11-17",
    title: "一键升级与备份",
    added: [
      { title: "源码 ZIP 升级", description: "在原实例上传源码 ZIP，自动构建、备份、切换和启动。" },
      { title: "ZIP 备份", description: "手动备份输出带版本和时间的 ZIP，支持校验及恢复。" },
    ],
    fixed: [
      { title: "登录与头像提示", description: "修复登录提示残留、初始化密码显示时的动画，以及头像之间的悬停提示切换。" },
    ],
  },
  "0.1.0": {
    date: "2026-11-17",
    title: "RSM 首个版本",
    added: [
      { title: "需求与排期管理", description: "提供甘特图、需求池和归档，支持需求录入、开发排期与账号权限管理。" },
    ],
  },
};

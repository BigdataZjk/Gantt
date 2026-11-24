export async function copyText(text: string, anchor?: HTMLElement): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 剪贴板写入被拒绝时使用兼容复制。
  }
  const previousFocus = document.activeElement;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.readOnly = true;
  textarea.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none";
  const container = (anchor?.isConnected ? anchor : document.activeElement)?.closest('[role="dialog"]') ?? document.body;
  container.append(textarea);
  try {
    textarea.focus({ preventScroll: true });
    textarea.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
    if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
  }
}

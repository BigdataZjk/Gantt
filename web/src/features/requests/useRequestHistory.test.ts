import { afterEach, describe, expect, it } from "vitest";
import { requestHistoryShortcut } from "./useRequestHistory";

describe("需求操作快捷键", () => {
  afterEach(() => { document.body.replaceChildren(); });

  it("识别 Ctrl 和 Command 的撤回及重做", () => {
    expect(requestHistoryShortcut(new KeyboardEvent("keydown", { key: "z", ctrlKey: true }))).toBe("undo");
    expect(requestHistoryShortcut(new KeyboardEvent("keydown", { key: "Z", ctrlKey: true, shiftKey: true }))).toBe("redo");
    expect(requestHistoryShortcut(new KeyboardEvent("keydown", { key: "z", metaKey: true, shiftKey: true }))).toBe("redo");
    expect(requestHistoryShortcut(new KeyboardEvent("keydown", { key: "z", altKey: true, ctrlKey: true }))).toBeNull();
  });

  it("保留文本输入的原生撤回及重做", () => {
    for (const html of ['<input />', '<textarea></textarea>', '<div contenteditable="true"><span></span></div>', '<div role="textbox"></div>']) {
      document.body.innerHTML = html;
      const element = document.querySelector("span") ?? document.body.firstElementChild!;
      for (const shiftKey of [false, true]) {
        const event = new KeyboardEvent("keydown", { key: "z", ctrlKey: true, shiftKey });
        element.dispatchEvent(event);
        expect(requestHistoryShortcut(event)).toBeNull();
      }
    }
  });
});

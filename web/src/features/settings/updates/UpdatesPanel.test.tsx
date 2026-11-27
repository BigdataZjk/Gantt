import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { UpdatesPanel } from "./UpdatesPanel";

vi.mock("./releaseNotes", () => ({
  releaseNotes: {
    "0.1.2": {
      date: "2026-11-18",
      title: "需求管理",
      added: [{ title: "需求排序", description: "支持全量级联排序。" }],
    },
    "1.0.0": { date: "2026-12-01", title: "首个正式版本" },
    "0.1.8": {
      date: "2026-11-27",
      title: "排期保护",
      added: [
        { title: "一键下载备份", description: "下载 ZIP 文件。" },
        { title: "多字段排序", description: "按要求调整需求行顺序。" },
      ],
      fixed: [{ title: "滚动修复", description: "修复窄屏滚动。" }],
    },
    "1.0.1": {
      date: "2026-12-02",
      title: "排期优化",
      improved: [{ title: "手动备份", description: "保存为 ZIP 文件。" }],
    },
    "10.0.0": { date: "2026-12-03", title: "未来版本" },
  },
}));

it("只为当前可见的发布创建主版本分组", () => {
  render(<UpdatesPanel serverVersion="v0.1.8-build" />);

  expect(screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual(["V0"]);
  expect(within(screen.getByRole("region", { name: "V0" })).getAllByText(/^v0\./).map((label) => label.textContent))
    .toEqual(["v0.1.8", "v0.1.2"]);
  expect(screen.getByText("v0.1.8")).toHaveAttribute("aria-current", "true");
});

it("跨主版本按版本号倒序分组，保留每组的版本节点", () => {
  render(<UpdatesPanel serverVersion="1.0.1" />);

  expect(screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual(["V1", "V0"]);
  expect(within(screen.getByRole("region", { name: "V1" })).getAllByText(/^v1\./).map((label) => label.textContent))
    .toEqual(["v1.0.1", "v1.0.0"]);
  expect(within(screen.getByRole("region", { name: "V0" })).getAllByText(/^v0\./).map((label) => label.textContent))
    .toEqual(["v0.1.8", "v0.1.2"]);
  expect(screen.getByText("v1.0.1").closest("details")).toHaveAttribute("open");
  expect(screen.getByText("v0.1.8").closest("details")).not.toHaveAttribute("open");
});

it("按条目标题和说明过滤并展开命中的版本", async () => {
  const user = userEvent.setup();
  render(<UpdatesPanel serverVersion="1.0.1" />);
  const search = screen.getByRole("searchbox", { name: "搜索更新日志" });
  await user.type(search, "ｚｉｐ 备份");

  const v1 = within(screen.getByRole("region", { name: "V1" }));
  const v0 = within(screen.getByRole("region", { name: "V0" }));
  expect(v1.getByText("手动备份")).toBeVisible();
  expect(v0.getByText("一键下载备份")).toBeVisible();
  expect(v0.queryByText("多字段排序")).not.toBeInTheDocument();
  expect(v0.queryByText("修复", { exact: true })).not.toBeInTheDocument();
  expect(screen.queryByText("v1.0.0")).not.toBeInTheDocument();
  expect(screen.queryByText("v0.1.2")).not.toBeInTheDocument();

  await user.clear(search);
  await user.type(search, "级联排序");
  expect(screen.getByText("需求排序", { exact: true })).toBeVisible();
  expect(screen.queryByRole("region", { name: "V1" })).not.toBeInTheDocument();
});

it.each(["0.1.8", "V0.1.8"])("搜索 %s 时展开所属分组下的完整版本日志", async (version) => {
  const user = userEvent.setup();
  render(<UpdatesPanel serverVersion="0.1.8" />);
  await user.type(screen.getByRole("searchbox", { name: "搜索更新日志" }), version);

  const v0 = within(screen.getByRole("region", { name: "V0" }));
  expect(v0.getByText("v0.1.8").closest("details")).toHaveAttribute("open");
  expect(v0.getByText("一键下载备份")).toBeVisible();
  expect(v0.getByText("多字段排序")).toBeVisible();
  expect(v0.getByText("滚动修复")).toBeVisible();
  expect(v0.queryByText("v0.1.2")).not.toBeInTheDocument();
});

it("同时输入版本号和关键词时仅筛选该版本中的条目", async () => {
  const user = userEvent.setup();
  render(<UpdatesPanel serverVersion="1.0.1" />);
  await user.type(screen.getByRole("searchbox", { name: "搜索更新日志" }), "0.1.8 备份");

  expect(screen.getByText("一键下载备份")).toBeVisible();
  expect(screen.queryByText("多字段排序")).not.toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "V1" })).not.toBeInTheDocument();
});

it("无结果时显示状态，清空后恢复搜索前的展开状态", async () => {
  const user = userEvent.setup();
  render(<UpdatesPanel serverVersion="1.0.1" />);
  await user.click(screen.getByText("v1.0.1"));
  await user.click(screen.getByText("v0.1.2"));

  const search = screen.getByRole("searchbox", { name: "搜索更新日志" });
  await user.type(search, "手动备份");
  expect(screen.getByText("手动备份")).toBeVisible();
  await user.type(search, "暂无");
  expect(screen.getByRole("status")).toHaveTextContent("没有匹配的更新记录");

  await user.click(screen.getByRole("button", { name: "清空搜索" }));
  expect(search).toHaveValue("");
  expect(search).toHaveFocus();
  expect(screen.getByText("v1.0.1").closest("details")).not.toHaveAttribute("open");
  expect(screen.getByText("v0.1.2").closest("details")).toHaveAttribute("open");
});

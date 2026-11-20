import { expect, test, type Page } from "@playwright/test";
import type { ApiRequest, State } from "../src/api/types";
import { ARCHIVE_COLUMN_KEYS, COLUMN_CATALOG } from "../src/lib/format";
import { calendar, domains, request, users } from "../src/test/fixtures";

async function openTable(page: Page, archive: boolean, options: { requests?: ApiRequest[]; columns?: string[] } = {}) {
  const original = await (await page.request.get("/api/state")).json() as State;
  const rows = [
    request({ id: 1, name: "需求10", domain: "广告域", days: 10 }),
    request({ id: 2, name: "需求2", domain: "广告域", days: 2 }),
    request({ id: 3, name: "需求3", domain: "流量域", days: 3 }),
    request({ id: 4, name: "需求4", domain: "流量域", days: 2 }),
  ];
  const state: State = { ...original, setupRequired: false, me: null, users, domains, calendar, requests: options.requests ?? rows.flatMap((row) => [
    { ...row, poolEnteredAt: `2026-11-18T00:00:0${row.id}Z` },
    { ...row, id: row.id + 10, archived: true, archivedAt: `2026-11-18T01:00:0${5 - row.id}Z` },
  ]) };
  await page.route("**/api/state", (route) => route.fulfill({ json: state }));
  await page.route("**/api/presence", (route) => route.fulfill({ json: { users: [], guests: 0 } }));
  await page.addInitScript(({ archive, columns }) => {
    const key = "rsm.ui.v2:guest";
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ requirementTab: archive ? "archive" : "pool", visibleColumns: columns, archiveVisibleColumns: columns }));
  }, { archive, columns: options.columns ?? ["name", "domain", "days"] });
  await page.goto("/");
}

const ids = (page: Page) => page.locator('[data-scroll-container="table"] [data-row]').evaluateAll((elements) => elements.map((element) => Number((element as HTMLElement).dataset.row)));

for (const archive of [false, true]) {
  test(`${archive ? "归档" : "需求池"}对全表排序后按视口展示，右上角重置随滚动固定`, async ({ page }) => {
    const count = 72;
    const columns = COLUMN_CATALOG.filter(({ key }) => !archive || ARCHIVE_COLUMN_KEYS.includes(key));
    const rows = Array.from({ length: count }, (_, index) => {
      const id = index + 1;
      const timestamp = new Date(Date.UTC(2026, 10, 18, 0, 0, id)).toISOString();
      const rank = (id + count / 2) % count;
      const firstGroup = rank < count / 2;
      const date = new Date(Date.UTC(2026, 10, 18 + rank)).toISOString().slice(0, 10);
      const link = `https://example.com/${rank}`;
      return request({
        id, name: `需求 ${rank}`, archived: archive, archivedAt: archive ? timestamp : "", poolEnteredAt: timestamp,
        days: rank + 1, requesterRank: archive ? undefined : rank + 1, domain: firstGroup ? "广告域" : "流量域", requestType: firstGroup ? "常规需求" : "数据需求",
        developer: firstGroup ? "u2" : "u1", status: firstGroup ? "待开发" : "开发中",
        start: date, delivery: date, requestedAt: date, expected: date, review: date,
        requester: `提需人 ${rank}`, project: `项目 ${rank}`, notes: `备注 ${rank}`, prd: link, wangyue: link, brd: link,
      });
    });
    await openTable(page, archive, { requests: rows, columns: columns.map(({ key }) => key) });
    const table = page.getByRole("table", { name: archive ? "归档需求列表" : "需求列表", exact: true });
    const header = (label: string) => table.getByRole("columnheader", { name: label, exact: true }).getByRole("button");
    const reset = page.getByRole("button", { name: "重置排序", exact: true });
    const byDays = [...rows].sort((a, b) => a.days - b.days);
    const rankedIds = byDays.map(({ id }) => id);
    const groups = [rankedIds.slice(0, count / 2), rankedIds.slice(count / 2)].map((group) => group.toSorted((a, b) => b - a));
    const groupedColumns = new Set(["domain", "requestType", "developer", "status"]);

    const expectFullOrder = async (ordered: number[]) => {
      const seen = new Set<number>();
      for (const fraction of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
        const visible = await table.evaluate((el, position) => {
          const rowHeight = el.querySelector<HTMLElement>("[data-row]")!.offsetHeight;
          el.scrollTop = (el.scrollHeight - el.clientHeight) * position;
          return {
            first: Math.floor(el.scrollTop / rowHeight),
            last: Math.ceil((el.scrollTop + el.clientHeight) / rowHeight) - 1,
          };
        }, fraction);
        await expect.poll(async () => {
          const mounted = await ids(page);
          const first = ordered.indexOf(mounted[0]!);
          if (first < 0 || first > visible.first || first + mounted.length <= Math.min(count - 1, visible.last)) return false;
          if (!mounted.every((id, index) => id === ordered[first + index])) return false;
          mounted.forEach((id) => seen.add(id));
          return true;
        }).toBe(true);
      }
      expect(seen.size).toBe(count);
    };

    await expect(table).toHaveAttribute("aria-rowcount", String(count + 1));
    expect(await ids(page)).not.toContain(byDays[0]!.id);
    await header("开发人天").click();
    await expect.poll(async () => (await ids(page))[0]).toBe(byDays[0]!.id);
    await expect(reset).toBeVisible();
    const topRight = (await reset.boundingBox())!;
    const tableBox = (await table.boundingBox())!;
    const headerBox = (await table.getByRole("row").first().boundingBox())!;
    expect(topRight.y - headerBox.y - headerBox.height).toBeGreaterThanOrEqual(0);
    expect(topRight.y - headerBox.y - headerBox.height).toBeLessThan(20);
    expect(tableBox.x + tableBox.width - topRight.x - topRight.width).toBeLessThan(24);
    await table.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await expect.poll(async () => (await ids(page)).at(-1)).toBe(byDays.at(-1)!.id);
    expect(await reset.boundingBox()).toEqual(topRight);
    await reset.click();
    await expect.poll(async () => (await ids(page))[0]).toBe(count);

    for (const { key, label } of columns) {
      await test.step(`${label}升序和降序贯穿整张表`, async () => {
        const grouped = groupedColumns.has(key);
        const button = header(label);
        await button.click();
        await expectFullOrder(grouped ? groups.flat() : rankedIds);
        await button.click();
        await expectFullOrder(grouped ? groups.toReversed().flat() : rankedIds.toReversed());
        await reset.click();
      });
    }

    await header("业务域").click();
    await header("开发人天").click();
    await expectFullOrder(rankedIds);
    await header("开发人天").click();
    await expectFullOrder([rankedIds.slice(0, count / 2).toReversed(), rankedIds.slice(count / 2).toReversed()].flat());
  });

  test(`${archive ? "归档" : "需求池"}表头级联排序、切换方向、持久化与一键重置`, async ({ page }, testInfo) => {
    const writes: string[] = [];
    page.on("request", (request) => {
      if (request.method() !== "GET" && /^\/api\/(requests|preferences)/.test(new URL(request.url()).pathname)) writes.push(request.url());
    });
    await openTable(page, archive);
    const offset = archive ? 10 : 0;
    const defaultOrder = archive ? [11, 12, 13, 14] : [4, 3, 2, 1];
    const reset = page.getByRole("button", { name: "重置排序", exact: true });
    const domainColumn = page.getByRole("columnheader", { name: "业务域", exact: true });
    const daysColumn = page.getByRole("columnheader", { name: "开发人天", exact: true });
    const domainLabel = domainColumn.getByText("业务域", { exact: true });
    const domain = domainColumn.getByRole("button");
    const days = daysColumn.getByRole("button");
    await expect.poll(() => ids(page)).toEqual(defaultOrder);
    await domainLabel.click();
    const domainWidth = (await domainColumn.boundingBox())!.width;
    await domainColumn.click({ position: { x: domainWidth - 5, y: 20 } });
    await expect.poll(() => ids(page)).toEqual(defaultOrder);
    await expect(reset).toHaveCount(0);
    await domain.click();
    await expect(reset).toBeVisible();
    await days.click();
    await domainLabel.click();
    await daysColumn.getByText("2", { exact: true }).click();
    await expect.poll(() => ids(page)).toEqual([2, 1, 4, 3].map((id) => id + offset));
    await expect(domain).toHaveAccessibleName(/第 1 排序，升序/);
    await expect(days).toHaveAccessibleName(/第 2 排序，升序/);
    await expect(domainColumn).toHaveAttribute("aria-sort", "ascending");
    await domain.click();
    await expect.poll(() => ids(page)).toEqual([4, 3, 2, 1].map((id) => id + offset));
    await page.screenshot({ path: testInfo.outputPath("multi-sort.png") });
    await page.getByRole("tab", { name: archive ? "需求池" : "已归档", exact: true }).click();
    await expect(reset).toHaveCount(0);
    await page.getByRole("tab", { name: archive ? "已归档" : "需求池", exact: true }).click();
    await expect(domain).toHaveAccessibleName(/第 1 排序，降序/);
    await page.reload();
    await expect(domain).toHaveAccessibleName(/第 1 排序，降序/);
    await days.focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => ids(page)).toEqual([3, 4, 1, 2].map((id) => id + offset));
    await reset.click();
    await expect(reset).toHaveCount(0);
    await expect.poll(() => ids(page)).toEqual(defaultOrder);
    await page.getByRole("columnheader").getByRole("button", { name: /^需求名称，/ }).click();
    await expect.poll(() => ids(page)).toEqual([2, 3, 4, 1].map((id) => id + offset));
    expect(writes).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true);
  });
}

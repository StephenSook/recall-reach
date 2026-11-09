"use client";

import type { ChartRef, ColDef, DefaultMenuItem, GridApi, IAggFuncParams, ICellRendererParams, IRowNode, ProcessCellForExportParams, ShouldRowBeSkippedParams, SideBarDef, StatusPanelDef } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { useMemo, useRef, useState } from "react";
import { ENTERPRISE_MODULES, licenseGrid } from "@/app/gridEnterprise";
import { gridTheme } from "@/app/gridSetup";
import { chartRole, copiedCell, excelColumns, grouped, hasSaleWithNoUsdPrice, onlyUnidentified, refundTotal, saleCellWords, saleForExport, saleLabel, saleSum, usd } from "./gridFeatures";
import { hiddenColumns, inTab, soldLabel, TELL_CPSC_COLUMNS, type GridRow, type GridTab } from "./gridRows";
import { chipClass } from "./labels";

const TABS: { id: GridTab; label: string }[] = [
  { id: "needs", label: "Needs review" },
  { id: "words", label: "Share a word only" },
  { id: "done", label: "Done" },
  { id: "cleared", label: "Cleared" },
  { id: "shelf", label: "Pull from the shelf" },
  { id: "unidentified", label: "Couldn't identify" },
  { id: "all", label: "All candidates" },
];

const GROUPS: { field: string | null; label: string }[] = [
  { field: null, label: "No groups" },
  { field: "recallNumber", label: "By recall" },
  { field: "state", label: "By state" },
];

const PAGE_SIZE = 50;

type Row = Partial<GridRow>;

// On a group row there's no data, only the value it groups by.
function StateCell({ data, value }: ICellRendererParams<Row>) {
  if (!data) return value ? <span className="chip">{String(value)}</span> : null;
  return data.state ? <span className={`chip chip-${data.verdict}`}>{data.state}</span> : null;
}
function PathCell({ data, value }: ICellRendererParams<Row>) {
  const path = data?.path ?? (value as string | null | undefined);
  return path ? <span className={chipClass(path)}>{path}</span> : null;
}
function SoldCell({ data }: ICellRendererParams<Row>) {
  return data ? soldLabel(data) : null;
}
function OpenCell({ data }: ICellRendererParams<Row>) {
  return data?.anchor ? <a href={data.anchor}>Open</a> : null;
}

function leavesOf(node: IRowNode<Row>): Row[] {
  if (node.data) return [node.data];
  return (node.childrenAfterFilter ?? []).flatMap(leavesOf);
}

/** A group's sales, each counted once. The object is how AG Grid takes a total that's a number with words beside it. */
function saleTotal({ rowNode }: IAggFuncParams<Row>) {
  const sum = saleSum(leavesOf(rowNode));
  return { value: sum.usd, unpriced: sum.unpriced, toString: () => saleLabel(sum), toNumber: () => sum.usd };
}

/** A payment nobody could identify is PayPal's record, not the shop's, so no file made from this table carries it. */
const nodeRows = (node: IRowNode<Row> | null | undefined): Row[] => (node?.data ? [node.data] : (node?.allLeafChildren ?? []).flatMap((n) => (n.data ? [n.data] : [])));
const keepsOutUnidentified = (p: ShouldRowBeSkippedParams<Row>) => onlyUnidentified(nodeRows(p.node));
// AG Grid's type says string, and Excel only gets a number cell from a number, so a number goes through as one.
const cellForExport = (p: ProcessCellForExportParams<Row>): string =>
  (p.column.getColId() === "saleUsd" ? saleForExport(p.value, p.node?.data) : p.value) as string;
const cellForClipboard = (p: ProcessCellForExportParams<Row>): string => (onlyUnidentified(nodeRows(p.node)) ? "" : copiedCell(p.column.getColId(), p.value, p.node?.data)) as string;
// The right-click menu's default export and chart entries would skip the rules above.
const MENU_ITEMS: DefaultMenuItem[] = ["copy", "copyWithHeaders"];

const SET_FILTER = "agSetColumnFilter";

const columns: ColDef<Row>[] = [
  { field: "recallNumber", headerName: "Recall", width: 80, cellClass: "id", filter: SET_FILTER, chartDataType: chartRole("recallNumber") },
  { field: "product", headerName: "Product", flex: 2, minWidth: 130, wrapText: true, autoHeight: true, filter: "agTextColumnFilter", chartDataType: chartRole("product") },
  { field: "itemTitle", headerName: "Your item", flex: 2, minWidth: 130, wrapText: true, autoHeight: true, filter: "agTextColumnFilter", chartDataType: chartRole("itemTitle") },
  { field: "state", headerName: "State", width: 136, cellRenderer: StateCell, cellClass: "chip-cell", wrapText: true, autoHeight: true, filter: SET_FILTER, chartDataType: chartRole("state") },
  { field: "path", headerName: "Path", width: 144, cellRenderer: PathCell, cellClass: "chip-cell", filter: SET_FILTER, chartDataType: chartRole("path") },
  { field: "soldOn", headerName: "Sold", width: 96, cellDataType: "dateString", filter: "agDateColumnFilter", cellRenderer: SoldCell, chartDataType: chartRole("soldOn") },
  { field: "saleUsd", headerName: "Sale (USD)", width: 124, type: "rightAligned", valueFormatter: (p) => saleCellWords(p.value, p.data), aggFunc: saleTotal, filter: "agNumberColumnFilter", chartDataType: chartRole("saleUsd") },
  { field: "noticeState", headerName: "Message", width: 92, wrapText: true, autoHeight: true, filter: SET_FILTER, chartDataType: chartRole("noticeState") },
  { field: "reason", headerName: "Why", flex: 3, minWidth: 170, wrapText: true, autoHeight: true, filter: "agTextColumnFilter", chartDataType: chartRole("reason") },
  { colId: "open", headerName: "Open", headerClass: "header-for-readers", width: 52, cellRenderer: OpenCell, sortable: false, resizable: false, suppressColumnsToolPanel: true },
];

const EXPORT_RULES = { shouldRowBeSkipped: keepsOutUnidentified };
const DEFAULT_COL: ColDef<Row> = { sortable: true, resizable: true };
const AUTO_GROUP: ColDef<Row> = { headerName: "Group", minWidth: 180 };
// The buttons above the table are the one way to group, so the chart and the group buttons can't disagree with the grid.
const SIDE_BAR: SideBarDef = {
  toolPanels: [{ id: "columns", labelDefault: "Columns", labelKey: "columns", iconKey: "columns", toolPanel: "agColumnsToolPanel", toolPanelParams: { suppressRowGroups: true, suppressValues: true, suppressPivots: true, suppressPivotMode: true } }, "filters"],
  hiddenByDefault: false,
};
const GROUPABLE = ["recallNumber", "state"] as const;
const STATUS_BAR: { statusPanels: StatusPanelDef[] } = {
  statusPanels: [
    { statusPanel: "agTotalAndFilteredRowCountComponent", align: "left" },
    { statusPanel: "agSelectedRowCountComponent", align: "left" },
  ],
};

/** The seller's queue as a table: every candidate, findable. A row opens its window, where the work happens. */
export default function MatchGrid({ rows, startOn = "needs", listings = false, licenseKey = null }: { rows: GridRow[]; startOn?: GridTab; listings?: boolean; licenseKey?: string | null }) {
  // Before the first grid draws, or it shows the watermark.
  licenseGrid(licenseKey);
  const api = useRef<GridApi<Row> | null>(null);
  const tabRef = useRef<GridTab>(startOn);
  const [tab, setTab] = useState<GridTab>(startOn);
  const [groupBy, setGroupBy] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const chartBox = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<ChartRef | null>(null);
  const [charted, setCharted] = useState(false);
  const isGrouped = groupBy !== null;
  // What this tab could cost in refunds, by the shop's own prices and order dates. PayPal's own date decides when a refund is sent,
  // as the refund windows page says, so the label names the date it used.
  const refund = useMemo(() => refundTotal(rows.filter((r) => inTab(r, tab))), [rows, tab]);
  const hasTellCpsc = rows.some((r) => r.tellCpsc);
  const priceInOtherCurrency = hasSaleWithNoUsdPrice(rows);
  const shownColumns = useMemo(() => {
    const hidden = hiddenColumns(rows, listings);
    return grouped(columns.filter((c) => !hidden.has(String(c.field))), groupBy, GROUPABLE);
  }, [rows, listings, groupBy]);

  const choose = (next: GridTab) => {
    tabRef.current = next;
    setTab(next);
    api.current?.onFilterChanged();
  };

  const exportExcel = () => {
    const grid = api.current;
    if (!grid) return;
    grid.exportDataAsExcel({
      fileName: "recall-queue.xlsx",
      columnKeys: excelColumns((grid.getAllDisplayedColumns() ?? []).map((c) => c.getColId())),
      shouldRowBeSkipped: keepsOutUnidentified,
      processCellCallback: cellForExport,
    });
  };

  // In a space of its own under the buttons: AG's floating window opens in the middle of a long table, out of sight. Never while
  // the table is grouped: the chart reads group rows as well as sales, and would count the money twice.
  const closeChart = () => {
    chartRef.current?.destroyChart();
    chartRef.current = null;
    setCharted(false);
  };

  const chooseGroup = (field: string | null) => {
    if (field) closeChart();
    setGroupBy(field);
  };

  const toggleChart = () => {
    if (chartRef.current) {
      closeChart();
      return;
    }
    if (!chartBox.current || isGrouped) return;
    chartRef.current = api.current?.createCrossFilterChart({
      chartType: "column",
      chartContainer: chartBox.current,
      // By recall only. A sale matching two recalls belongs to each, but would count twice in a state.
      cellRange: { columns: ["recallNumber", "saleUsd"] },
      aggFunc: "sum",
      chartThemeOverrides: { common: { title: { enabled: true, text: "Sales in USD by recall" } } },
    }) ?? null;
    setCharted(chartRef.current !== null);
  };

  return (
    <section className="window" data-testid="match-grid" aria-label="All matches">
      <header className="window-bar grid-bar">
        <div className="tabs" role="group" aria-label="Show">
          {TABS.filter((t) => (t.id !== "words" || rows.some((r) => r.apart)) && !(listings && t.id === "done")).map((t) => (
            <button key={t.id} type="button" className="tab" aria-pressed={tab === t.id} onClick={() => choose(t.id)}>
              {listings && t.id === "shelf" ? "On the shelf" : t.label} ({rows.filter((r) => inTab(r, t.id)).length})
            </button>
          ))}
        </div>
        <label className="grid-search">
          <span className="sr-only">Filter these rows</span>
          <input type="search" placeholder="Filter" onChange={(e) => api.current?.setGridOption("quickFilterText", e.target.value)} />
        </label>
      </header>
      <div className="tabs grid-groups" role="group" aria-label="Group">
        {GROUPS.map((g) => (
          <button key={g.label} type="button" className="tab" aria-pressed={groupBy === g.field} onClick={() => chooseGroup(g.field)}>
            {g.label}
          </button>
        ))}
        {refund.count > 0 ? (
          <span className="grid-refund-total" data-testid="refund-total">
            Refund eligible by order date, this tab: <strong>{refund.count}</strong> ({usd(refund.usd)}
            {refund.unpriced > 0 ? `, ${refund.unpriced} with no price in dollars` : ""})
          </span>
        ) : null}
      </div>
      <AgGridReact<Row>
        modules={ENTERPRISE_MODULES}
        theme={gridTheme}
        rowData={rows}
        columnDefs={shownColumns}
        defaultColDef={DEFAULT_COL}
        autoGroupColumnDef={AUTO_GROUP}
        domLayout="autoHeight"
        pagination={rows.length > PAGE_SIZE}
        paginationPageSize={PAGE_SIZE}
        paginationPageSizeSelector={false}
        getRowId={(p) => String(p.data.matchId)}
        statusBar={STATUS_BAR}
        sideBar={SIDE_BAR}
        enableCharts
        suppressAggFuncInHeader
        getContextMenuItems={() => MENU_ITEMS}
        processCellForClipboard={cellForClipboard}
        defaultExcelExportParams={EXPORT_RULES}
        defaultCsvExportParams={EXPORT_RULES}
        cellSelection
        rowSelection={listings ? undefined : { mode: "multiRow", checkboxes: true, headerCheckbox: true, enableClickSelection: false, isRowSelectable: (n: IRowNode<Row>) => Boolean(n.data?.approvable) }}
        selectionColumnDef={{ width: 44, minWidth: 44, maxWidth: 44, resizable: false, sortable: false }}
        onCellClicked={(e) => {
          // A row opens its window. The checkbox only picks it.
          if (e.column.getColId() !== "ag-Grid-SelectionColumn" && e.data?.anchor) window.location.hash = e.data.anchor;
        }}
        isExternalFilterPresent={() => true}
        doesExternalFilterPass={(n: IRowNode<Row>) => inTab(n.data as GridRow, tabRef.current)}
        onGridReady={(e) => {
          api.current = e.api;
        }}
        onSelectionChanged={(e) => setSelected(e.api.getSelectedRows().map((r) => String(r.matchId)))}
      />
      {/* No message or refund can come from a listing, so a store's queue has nothing to approve or export. */}
      {listings ? null : <div className="grid-actions">
        <form action="/api/queue/notices" method="post">
          {selected.map((id) => (
            <input key={id} type="hidden" name="matchId" value={id} />
          ))}
          <button type="submit" className="btn" disabled={selected.length === 0}>
            Approve selected ({selected.length})
          </button>
        </form>
        <button
          type="button"
          className="btn btn-outline"
          disabled={!hasTellCpsc}
          onClick={() =>
            api.current?.exportDataAsCsv({
              fileName: "tell-cpsc.csv",
              columnKeys: [...TELL_CPSC_COLUMNS],
              shouldRowBeSkipped: (p) => !p.node.data?.tellCpsc,
              exportedRows: "all",
            })
          }
        >
          Export Tell CPSC list
        </button>
        <button type="button" className="btn btn-outline" onClick={exportExcel}>
          Export to Excel
        </button>
        <button type="button" className="btn btn-outline" onClick={toggleChart} aria-pressed={charted} disabled={isGrouped} title={isGrouped ? "Choose No groups to chart sales" : undefined}>
          {charted ? "Hide chart" : "Chart sales"}
        </button>
      </div>}
      <div ref={chartBox} className={charted ? "grid-chart" : undefined} data-testid="grid-chart" />
      {charted && priceInOtherCurrency ? <p className="note" data-testid="chart-note">Sales with no USD price aren&apos;t in this chart.</p> : null}
    </section>
  );
}

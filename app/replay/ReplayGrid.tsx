"use client";

import type { ColDef, GridApi, ICellRendererParams, IRowNode, SideBarDef, StatusPanelDef } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { useMemo, useRef, useState } from "react";
import { licenseGrid } from "@/app/gridEnterprise";
import { gridTheme } from "@/app/gridSetup";
import { grouped } from "@/app/queue/gridFeatures";
import type { ReplayOutcome, ReplayRow } from "@/server/replay/replay";
import { OUTCOME_CHIP, SPLIT_CHIP } from "./labels";

type Tab = ReplayOutcome | "ALL";
const TABS: { id: Tab; label: string }[] = [
  { id: "ALL", label: "All" },
  { id: "MATCH", label: "Matched" },
  { id: "SCOPE_GAP", label: "Can't tell yet" },
  { id: "CLEARED", label: "Cleared" },
  { id: "NOT_NEAR", label: "Nothing near" },
];

const GROUPS: { field: string | null; label: string }[] = [
  { field: null, label: "No groups" },
  { field: "outcome", label: "By outcome" },
  { field: "saleSplit", label: "By path" },
];

// On a group row there's no data, only the value it groups by.
function OutcomeCell({ data, value }: ICellRendererParams<ReplayRow>) {
  const outcome = data?.outcome ?? (value as ReplayOutcome | null | undefined);
  return outcome ? <span className={`chip chip-${outcome}`}>{OUTCOME_CHIP[outcome]}</span> : null;
}
function SplitCell({ data, value }: ICellRendererParams<ReplayRow>) {
  const split = data?.saleSplit ?? (value as ReplayRow["saleSplit"] | undefined);
  return split ? <span className={split === "REFUND_ELIGIBLE" ? "chip chip-refund" : "chip"}>{SPLIT_CHIP[split]}</span> : null;
}

// The words on the chips, so a set filter and a group row read the same as the column.
const outcomeWord = (value: unknown) => OUTCOME_CHIP[value as ReplayOutcome] ?? String(value ?? "");
const splitWord = (value: unknown) => (value ? (SPLIT_CHIP[value as keyof typeof SPLIT_CHIP] ?? String(value)) : "");

const columns: ColDef<ReplayRow>[] = [
  { field: "recallNumber", headerName: "Recall", width: 84, cellClass: "id", filter: true },
  { field: "recallDate", headerName: "Recalled", width: 104, cellDataType: "dateString", filter: "agDateColumnFilter" },
  { field: "recallTitle", headerName: "CPSC's title", flex: 3, minWidth: 220, wrapText: true, autoHeight: true, filter: true },
  { field: "outcome", headerName: "Outcome", width: 136, cellRenderer: OutcomeCell, cellClass: "chip-cell", filter: "agSetColumnFilter", filterParams: { valueFormatter: (p: { value: unknown }) => outcomeWord(p.value) }, valueFormatter: (p) => outcomeWord(p.value), enableRowGroup: true },
  { field: "saleSplit", headerName: "Path", width: 146, cellRenderer: SplitCell, cellClass: "chip-cell", filter: "agSetColumnFilter", filterParams: { valueFormatter: (p: { value: unknown }) => splitWord(p.value) }, valueFormatter: (p) => splitWord(p.value), enableRowGroup: true },
  { field: "itemTitle", headerName: "Demo shop's item", flex: 2, minWidth: 150, wrapText: true, autoHeight: true, filter: true },
];

const DEFAULT_COL: ColDef<ReplayRow> = { sortable: true, resizable: true };
const AUTO_GROUP: ColDef<ReplayRow> = { headerName: "Group", minWidth: 180 };
const SIDE_BAR: SideBarDef = { toolPanels: ["columns", "filters"], hiddenByDefault: false };
const STATUS_BAR: { statusPanels: StatusPanelDef[] } = { statusPanels: [{ statusPanel: "agTotalAndFilteredRowCountComponent", align: "left" }] };

export default function ReplayGrid({ rows, licenseKey = null }: { rows: ReplayRow[]; licenseKey?: string | null }) {
  // Before the first grid draws, or it shows the watermark.
  licenseGrid(licenseKey);
  const api = useRef<GridApi<ReplayRow> | null>(null);
  const tabRef = useRef<Tab>("ALL");
  const [tab, setTab] = useState<Tab>("ALL");
  const [groupBy, setGroupBy] = useState<string | null>(null);
  const shownColumns = useMemo(() => grouped(columns, groupBy), [groupBy]);
  const choose = (next: Tab) => {
    tabRef.current = next;
    setTab(next);
    api.current?.onFilterChanged();
  };
  return (
    <section className="window" data-testid="replay-grid" aria-label="Every recall in this run">
      <header className="window-bar grid-bar">
        <div className="tabs" role="group" aria-label="Show">
          {TABS.map((t) => (
            <button key={t.id} type="button" className="tab" aria-pressed={tab === t.id} onClick={() => choose(t.id)}>
              {t.label} ({t.id === "ALL" ? rows.length : rows.filter((r) => r.outcome === t.id).length})
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
          <button key={g.label} type="button" className="tab" aria-pressed={groupBy === g.field} onClick={() => setGroupBy(g.field)}>
            {g.label}
          </button>
        ))}
        <button type="button" className="tab" onClick={() => api.current?.exportDataAsExcel({ fileName: "recall-replay.xlsx" })}>
          Export to Excel
        </button>
      </div>
      <AgGridReact<ReplayRow>
        theme={gridTheme}
        rowData={rows}
        columnDefs={shownColumns}
        defaultColDef={DEFAULT_COL}
        autoGroupColumnDef={AUTO_GROUP}
        domLayout="autoHeight"
        pagination
        paginationPageSize={50}
        paginationPageSizeSelector={false}
        getRowId={(p) => p.data.recallNumber}
        statusBar={STATUS_BAR}
        sideBar={SIDE_BAR}
        isExternalFilterPresent={() => tabRef.current !== "ALL"}
        doesExternalFilterPass={(n: IRowNode<ReplayRow>) => n.data?.outcome === tabRef.current}
        onGridReady={(e) => {
          api.current = e.api;
        }}
      />
    </section>
  );
}

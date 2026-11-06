"use client";

import type { ColDef, GridApi, ICellRendererParams, IRowNode } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { useRef, useState } from "react";
import { gridTheme } from "@/app/gridSetup";
import type { ReplayOutcome, ReplayRow } from "@/server/replay/replay";
import { OUTCOME_CHIP, SPLIT_CHIP } from "./labels";

type Tab = ReplayOutcome | "ALL";
const TABS: { id: Tab; label: string }[] = [
  { id: "ALL", label: "All" },
  { id: "MATCH", label: "Matched" },
  { id: "SCOPE_GAP", label: "Scope gap" },
  { id: "CLEARED", label: "Cleared" },
  { id: "NOT_NEAR", label: "Nothing near" },
];

function OutcomeCell({ data }: ICellRendererParams<ReplayRow>) {
  return data ? <span className={`chip chip-${data.outcome}`}>{OUTCOME_CHIP[data.outcome]}</span> : null;
}
function SplitCell({ data }: ICellRendererParams<ReplayRow>) {
  return data?.saleSplit ? <span className={data.saleSplit === "REFUND_ELIGIBLE" ? "chip chip-refund" : "chip"}>{SPLIT_CHIP[data.saleSplit]}</span> : null;
}

const columns: ColDef<ReplayRow>[] = [
  { field: "recallNumber", headerName: "Recall", width: 84, cellClass: "id", filter: true },
  { field: "recallDate", headerName: "Recalled", width: 104, cellDataType: "dateString", filter: "agDateColumnFilter" },
  { field: "recallTitle", headerName: "CPSC's title", flex: 3, minWidth: 220, wrapText: true, autoHeight: true, filter: true },
  { field: "outcome", headerName: "Outcome", width: 136, cellRenderer: OutcomeCell, cellClass: "chip-cell", filter: true },
  { field: "saleSplit", headerName: "Path", width: 146, cellRenderer: SplitCell, cellClass: "chip-cell", filter: true },
  { field: "itemTitle", headerName: "Demo shop's item", flex: 2, minWidth: 150, wrapText: true, autoHeight: true, filter: true },
];

export default function ReplayGrid({ rows }: { rows: ReplayRow[] }) {
  const api = useRef<GridApi<ReplayRow> | null>(null);
  const tabRef = useRef<Tab>("ALL");
  const [tab, setTab] = useState<Tab>("ALL");
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
      <AgGridReact<ReplayRow>
        theme={gridTheme}
        rowData={rows}
        columnDefs={columns}
        defaultColDef={{ sortable: true, resizable: true }}
        domLayout="autoHeight"
        pagination
        paginationPageSize={50}
        paginationPageSizeSelector={false}
        getRowId={(p) => p.data.recallNumber}
        isExternalFilterPresent={() => tabRef.current !== "ALL"}
        doesExternalFilterPass={(n: IRowNode<ReplayRow>) => n.data?.outcome === tabRef.current}
        onGridReady={(e) => {
          api.current = e.api;
        }}
      />
    </section>
  );
}

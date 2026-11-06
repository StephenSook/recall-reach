"use client";

import type { ColDef, GridApi, ICellRendererParams, IRowNode } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { useMemo, useRef, useState } from "react";
import { gridTheme } from "@/app/gridSetup";
import { inTab, TELL_CPSC_COLUMNS, type GridRow, type GridTab } from "./gridRows";
import { chipClass } from "./labels";

const TABS: { id: GridTab; label: string }[] = [
  { id: "needs", label: "Needs review" },
  { id: "cleared", label: "Cleared" },
  { id: "shelf", label: "Pull from the shelf" },
  { id: "all", label: "All candidates" },
];

const PAGE_SIZE = 50;

type Row = Partial<GridRow>;

function StateCell({ data }: ICellRendererParams<Row>) {
  return data?.state ? <span className={`chip chip-${data.verdict}`}>{data.state}</span> : null;
}
function PathCell({ data }: ICellRendererParams<Row>) {
  return data?.path ? <span className={chipClass(data.path)}>{data.path}</span> : null;
}
function OpenCell({ data }: ICellRendererParams<Row>) {
  return data?.anchor ? <a href={data.anchor}>Open</a> : null;
}

const columns: ColDef<Row>[] = [
  { field: "recallNumber", headerName: "Recall", width: 80, cellClass: "id", filter: true },
  { field: "product", headerName: "Product", flex: 2, minWidth: 130, wrapText: true, autoHeight: true, filter: true },
  { field: "itemTitle", headerName: "Your item", flex: 2, minWidth: 130, wrapText: true, autoHeight: true, filter: true },
  { field: "state", headerName: "State", width: 128, cellRenderer: StateCell, cellClass: "chip-cell", filter: true },
  { field: "path", headerName: "Path", width: 144, cellRenderer: PathCell, cellClass: "chip-cell", filter: true },
  { field: "soldOn", headerName: "Sold", width: 96, cellDataType: "dateString", filter: "agDateColumnFilter" },
  { field: "noticeState", headerName: "Message", width: 92, wrapText: true, autoHeight: true, filter: true },
  { field: "reason", headerName: "Why", flex: 3, minWidth: 170, wrapText: true, autoHeight: true, filter: true },
  { colId: "open", headerName: "", width: 52, cellRenderer: OpenCell, sortable: false, resizable: false },
];

/** The seller's queue as a table: every candidate, findable. A row opens its window, where the work happens. */
export default function MatchGrid({ rows }: { rows: GridRow[] }) {
  const api = useRef<GridApi<Row> | null>(null);
  const tabRef = useRef<GridTab>("needs");
  const [tab, setTab] = useState<GridTab>("needs");
  const [selected, setSelected] = useState<string[]>([]);
  const [shown, setShown] = useState(() => rows.filter((r) => inTab(r, "needs")).length);
  const totals = useMemo(() => [{ product: `${shown} of ${rows.length} shown` }], [shown, rows.length]);
  const hasTellCpsc = rows.some((r) => r.tellCpsc);

  const choose = (next: GridTab) => {
    tabRef.current = next;
    setTab(next);
    api.current?.onFilterChanged();
  };

  return (
    <section className="window" data-testid="match-grid" aria-label="All matches">
      <header className="window-bar grid-bar">
        <div className="tabs" role="group" aria-label="Show">
          {TABS.map((t) => (
            <button key={t.id} type="button" className="tab" aria-pressed={tab === t.id} onClick={() => choose(t.id)}>
              {t.label} ({rows.filter((r) => inTab(r, t.id)).length})
            </button>
          ))}
        </div>
        <label className="grid-search">
          <span className="sr-only">Filter these rows</span>
          <input type="search" placeholder="Filter" onChange={(e) => api.current?.setGridOption("quickFilterText", e.target.value)} />
        </label>
      </header>
      <AgGridReact<Row>
        theme={gridTheme}
        rowData={rows}
        columnDefs={columns}
        defaultColDef={{ sortable: true, resizable: true }}
        domLayout="autoHeight"
        pagination={rows.length > PAGE_SIZE}
        paginationPageSize={PAGE_SIZE}
        paginationPageSizeSelector={false}
        getRowId={(p) => String(p.data.matchId)}
        pinnedBottomRowData={totals}
        rowSelection={{ mode: "multiRow", checkboxes: true, headerCheckbox: true, enableClickSelection: false, isRowSelectable: (n: IRowNode<Row>) => Boolean(n.data?.approvable) }}
        selectionColumnDef={{ width: 44, minWidth: 44, maxWidth: 44, resizable: false, sortable: false }}
        onCellClicked={(e) => {
          // A row opens its window. The checkbox only picks it.
          if (e.column.getColId() !== "ag-Grid-SelectionColumn" && e.data?.anchor) window.location.hash = e.data.anchor;
        }}
        isExternalFilterPresent={() => tabRef.current !== "all"}
        doesExternalFilterPass={(n: IRowNode<Row>) => inTab(n.data as GridRow, tabRef.current)}
        onGridReady={(e) => {
          api.current = e.api;
        }}
        onModelUpdated={(e) => setShown(e.api.getDisplayedRowCount())}
        onSelectionChanged={(e) => setSelected(e.api.getSelectedRows().map((r) => String(r.matchId)))}
      />
      <div className="grid-actions">
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
              skipPinnedBottom: true,
              shouldRowBeSkipped: (p) => !p.node.data?.tellCpsc,
              exportedRows: "all",
            })
          }
        >
          Export Tell CPSC list
        </button>
      </div>
    </section>
  );
}

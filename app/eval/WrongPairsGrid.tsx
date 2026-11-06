"use client";

import type { ColDef, GridApi, IRowNode } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { useRef, useState } from "react";
import { gridTheme } from "@/app/gridSetup";
import { WRONG, type WrongPair } from "./wrongPairs";

const ALL = "All";
const TABS = [ALL, WRONG.REACHES_FAMILY, WRONG.SHOWN_TO_SELLER, WRONG.MISSED];

const columns: ColDef<WrongPair>[] = [
  { field: "recallNumber", headerName: "Recall", width: 84, cellClass: "id", filter: true },
  { field: "recallTitle", headerName: "CPSC's title", flex: 3, minWidth: 220, wrapText: true, autoHeight: true, filter: true },
  { field: "title", headerName: "Listing's title", flex: 3, minWidth: 200, wrapText: true, autoHeight: true, filter: true },
  { field: "really", headerName: "What it really is", width: 170, wrapText: true, autoHeight: true, filter: true },
  { field: "outcome", headerName: "What Recall Reach did", flex: 2, minWidth: 180, wrapText: true, autoHeight: true, filter: true },
];

export default function WrongPairsGrid({ rows }: { rows: WrongPair[] }) {
  const api = useRef<GridApi<WrongPair> | null>(null);
  const tabRef = useRef<string>(ALL);
  const [tab, setTab] = useState<string>(ALL);
  const choose = (next: string) => {
    tabRef.current = next;
    setTab(next);
    api.current?.onFilterChanged();
  };
  return (
    <section className="window" data-testid="eval-wrong-grid" aria-label="Every held-out pair it got wrong">
      <header className="window-bar grid-bar">
        <div className="tabs" role="group" aria-label="Show">
          {TABS.map((t) => (
            <button key={t} type="button" className="tab" aria-pressed={tab === t} onClick={() => choose(t)}>
              {t} ({t === ALL ? rows.length : rows.filter((r) => r.outcome === t).length})
            </button>
          ))}
        </div>
      </header>
      <AgGridReact<WrongPair>
        theme={gridTheme}
        rowData={rows}
        columnDefs={columns}
        defaultColDef={{ sortable: true, resizable: true }}
        domLayout="autoHeight"
        getRowId={(p) => p.data.pairId}
        isExternalFilterPresent={() => tabRef.current !== ALL}
        doesExternalFilterPass={(n: IRowNode<WrongPair>) => n.data?.outcome === tabRef.current}
        onGridReady={(e) => {
          api.current = e.api;
        }}
      />
    </section>
  );
}

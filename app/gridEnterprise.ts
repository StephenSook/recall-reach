// AG Grid Enterprise, for the two tables a shop owner works in: the queue and Recall Replay. Only those two import this, so
// every other page keeps the free grid. Nothing in a grid goes to a model: these features all run in the owner's browser.
import { AgChartsEnterpriseModule } from "ag-charts-enterprise";
import { ColumnApiModule, type Module, NumberFilterModule } from "ag-grid-community";
import {
  CellSelectionModule,
  ClipboardModule,
  ColumnMenuModule,
  ColumnsToolPanelModule,
  ContextMenuModule,
  ExcelExportModule,
  FiltersToolPanelModule,
  IntegratedChartsModule,
  LicenseManager,
  RowGroupingModule,
  RowGroupingPanelModule,
  SetFilterModule,
  SideBarModule,
  StatusBarModule,
} from "ag-grid-enterprise";
import "./gridSetup";

// Given to each of the two grids, not registered globally: a global module would apply to every grid opened after it, such as eval's.
export const ENTERPRISE_MODULES: Module[] = [
  ColumnApiModule,
  NumberFilterModule,
  RowGroupingModule,
  RowGroupingPanelModule,
  SetFilterModule,
  StatusBarModule,
  ExcelExportModule,
  SideBarModule,
  ColumnsToolPanelModule,
  FiltersToolPanelModule,
  ColumnMenuModule,
  ContextMenuModule,
  CellSelectionModule,
  ClipboardModule,
  IntegratedChartsModule.with(AgChartsEnterpriseModule),
];

let licensed = false;

/** Set once, before the first grid draws. With no key the grid still works, and shows AG's trial watermark. */
export function licenseGrid(key: string | null | undefined): void {
  if (licensed || !key) return;
  LicenseManager.setLicenseKey(key);
  licensed = true;
}

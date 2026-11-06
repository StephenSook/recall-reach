// The grid's parts and its look, for every grid in the app. AG Grid Community only.
import {
  CellStyleModule,
  ClientSideRowModelModule,
  CsvExportModule,
  DateFilterModule,
  ExternalFilterModule,
  ModuleRegistry,
  PaginationModule,
  PinnedRowModule,
  QuickFilterModule,
  RowApiModule,
  RowAutoHeightModule,
  RowSelectionModule,
  TextFilterModule,
  themeQuartz,
} from "ag-grid-community";

ModuleRegistry.registerModules([
  ClientSideRowModelModule,
  RowApiModule,
  RowSelectionModule,
  QuickFilterModule,
  TextFilterModule,
  DateFilterModule,
  ExternalFilterModule,
  CsvExportModule,
  PinnedRowModule,
  PaginationModule,
  CellStyleModule,
  RowAutoHeightModule,
]);

export const gridTheme = themeQuartz.withParams({
  cellHorizontalPadding: 8,
  headerColumnResizeHandleColor: "#d2d2d2",
  fontFamily: "inherit",
  fontSize: 14,
  foregroundColor: "#000000",
  accentColor: "#002af0",
  borderColor: "#d2d2d2",
  headerBackgroundColor: "#e8e8e8",
  headerFontWeight: 700,
  wrapperBorder: false,
  wrapperBorderRadius: 0,
  rowBorder: { style: "dashed", width: 2, color: "#d2d2d2" },
  selectedRowBackgroundColor: "rgba(165, 181, 255, 0.4)",
});

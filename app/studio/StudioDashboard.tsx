"use client";

// AG Studio 3.0.0 dashboard of recall outcomes, with AG's built-in AI agents.
// Every AG name below is taken from the 3.0.0 .d.ts files (see the import list in the report).

import { useMemo } from 'react';
import { AgStudio, AgStudioProvider, createWidgets } from 'ag-studio-react';
import type { AgGridWidgetOptions } from 'ag-studio-react';
import { AgStudioAiModule, createAiHarness } from 'ag-studio';
import type {
  AgAiHarnessSetup,
  AgDataSourcesDefinition,
  AgFieldDefinition,
  AgPanelConfig,
  AgReportState,
  AgWidgetField,
} from 'ag-studio';
import type { CustomCellRendererProps } from 'ag-grid-react';
import type { StudioRow } from '@/server/studio/dataset';
import { createStudioAdapter } from './adapter';
import { toStudioRows } from './rows';

export interface StudioDashboardProps {
  rows: ReadonlyArray<StudioRow>;
  licenseKey: string | null;
}

// ---------------------------------------------------------------------------
// Data: one in-memory source, "recalls". Widgets refer to fields as "recalls.<fieldId>".
// ---------------------------------------------------------------------------

const SOURCE_ID = 'recalls';
const OUTCOME_CHIP = 'outcomeChip';

const RECALL_FIELDS: AgFieldDefinition[] = [
  { id: 'recallNumber', name: 'Recall number', format: 'textFormat', cardinality: 'high', notBlank: true },
  { id: 'recallTitle', name: 'Recall', format: 'textFormat', cardinality: 'high' },
  { id: 'recallDate', name: 'Recall date', format: 'dateFormat' },
  // format '0' stops 2026 rendering as "2,026" (same pattern as AG's Olympic "year" field).
  { id: 'recallYear', name: 'Year', format: 'integerFormat', formatOptions: { format: '0' }, cardinality: 'low' },
  {
    id: 'outcome',
    name: 'Outcome',
    format: 'textFormat',
    cardinality: 'low',
    notBlank: true,
    // Studio never reads `context`; it hands it back to the grid's createCellRenderer.
    context: { cellRenderer: OUTCOME_CHIP },
  },
  { id: 'product', name: 'Product (CPSC)', format: 'textFormat', cardinality: 'high' },
  { id: 'itemTitle', name: 'Your item', format: 'textFormat', cardinality: 'high' },
];

const f = (fieldId: keyof StudioRow) => `${SOURCE_ID}.${fieldId}`;

// ---------------------------------------------------------------------------
// Starting dashboard: one page, two charts and a grid (24-column canvas).
// ---------------------------------------------------------------------------

const RECALL_COUNT = { id: f('recallNumber'), aggregation: 'countd' } as const;

const INITIAL_STATE: AgReportState = {
  pages: [
    {
      id: 'recalls',
      widgets: {
        'w-by-outcome': {
          type: 'bar-chart-grouped',
          dataMapping: {
            categoryKey: [{ id: f('outcome') }],
            valueKey: [RECALL_COUNT],
          },
          sort: [{ field: RECALL_COUNT, direction: 'desc' }],
          format: { title: { enabled: true, text: 'Recalls by outcome' } },
        },
        'w-by-year': {
          type: 'column-chart-grouped',
          dataMapping: {
            categoryKey: [{ id: f('recallYear') }],
            valueKey: [RECALL_COUNT],
          },
          sort: [{ field: { id: f('recallYear') }, direction: 'asc' }],
          format: { title: { enabled: true, text: 'Recalls per year' } },
        },
        'w-recall-list': {
          type: 'grid',
          dataMapping: {
            cols: [{ id: f('recallNumber') }, { id: f('outcome') }, { id: f('itemTitle') }, { id: f('recallTitle') }],
          },
          format: { title: { enabled: true, text: 'Recalls' } },
        },
      },
      widgetLayout: {
        'w-by-outcome': { xTrack: 0, yTrack: 0, xSpan: 12, ySpan: 16 },
        'w-by-year': { xTrack: 12, yTrack: 0, xSpan: 12, ySpan: 16 },
        'w-recall-list': { xTrack: 0, yTrack: 16, xSpan: 24, ySpan: 22 },
      },
    },
  ],
  selectedPageId: 'recalls',
  panels: {
    ai: { collapsed: false },
    filters: { collapsed: true },
  },
};

// The chat panel ('ai') exists only in edit mode (AgViewModePanelType is 'filters' only).
// Edit mode is therefore required; this hides the edit and data panels so the page shows
// just the dashboard, the chat and the filters.
const PANELS: AgPanelConfig = {
  edit: { left: ['ai'], right: ['filters'] },
};

// ---------------------------------------------------------------------------
// Customisation: the outcome column renders as a coloured chip.
// ---------------------------------------------------------------------------

const OUTCOME_COLOURS: Record<StudioRow["outcome"], string> = {
  Matched: '#e8590c',
  "Can't tell yet": '#fcc419',
  Cleared: '#69db7c',
  'Nothing near': '#ced4da',
};

function isOutcome(value: unknown): value is StudioRow["outcome"] {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(OUTCOME_COLOURS, value);
}

function OutcomeChip(props: CustomCellRendererProps) {
  const raw: unknown = props.value;
  if (raw == null) return null;
  const label =
    typeof props.valueFormatted === 'string' && props.valueFormatted !== '' ? props.valueFormatted : String(raw);
  if (!isOutcome(raw)) return <>{label}</>;
  return (
    <span
      style={{
        display: 'inline-block',
        // Small enough that "Nothing near" fits the grid's default column width.
        padding: '0 7px',
        borderRadius: 999,
        lineHeight: '20px',
        fontSize: 12,
        fontWeight: 600,
        // Black text clears 4.5:1 on all four backgrounds (lowest: 5.87:1 on #e8590c).
        color: '#000000',
        background: OUTCOME_COLOURS[raw],
      }}
    >
      {label}
    </span>
  );
}

const GRID_OPTIONS: AgGridWidgetOptions = {
  createCellRenderer: (field: AgWidgetField) =>
    field.context?.cellRenderer === OUTCOME_CHIP ? OutcomeChip : undefined,
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function StudioDashboard({ rows, licenseKey }: StudioDashboardProps) {
  const adapter = useMemo(() => createStudioAdapter(), []);
  // `data` may be replaced later: Studio processes changes to synchronous (in-memory) rows.
  const data = useMemo<AgDataSourcesDefinition>(
    () => ({
      description: "CPSC product recalls and the outcome of checking each against one resale shop's own catalog.",
      sources: [
        {
          id: SOURCE_ID,
          name: 'Recalls',
          description: 'Recall number, title, date and year from CPSC, the check outcome, and the matching shop item if any.',
          data: toStudioRows(rows),
          fields: RECALL_FIELDS,
        },
      ],
    }),
    [rows],
  );

  const widgets = useMemo(() => createWidgets({ overrides: [{ id: 'grid', options: GRID_OPTIONS }] }), []);

  // `ai` is read once, when Studio is created; a new adapter after that is ignored.
  const ai = useMemo<AgAiHarnessSetup>(
    () => ({ api }) => createAiHarness(api, { adapter, primary: 'lead' }),
    [adapter],
  );

  return (
    <AgStudioProvider modules={[AgStudioAiModule]} licenseKey={licenseKey ?? undefined}>
      <AgStudio
        style={{ width: '100%', height: '100%' }}
        mode="edit"
        panels={PANELS}
        data={data}
        initialState={INITIAL_STATE}
        widgets={widgets}
        ai={ai}
      />
    </AgStudioProvider>
  );
}

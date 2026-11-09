"use client";

// A dashboard widget of our own: the recalls to open first, each a link to its page. It reads through AG Studio's query, so the
// page's filters apply to it and it only ever sees the dashboard's own rows.
import { useEffect, useState } from 'react';
import type { AgBaseRegistry, AgDefaultWidgetDefinition, AgWidgetDataFormat, AgWidgetFieldReference, AgWidgetParams } from 'ag-studio';
import type { AgWidgetDefinition } from 'ag-studio-react';
import { OutcomeBadge } from './OutcomeBadge';
import { recallPage, recallsToRead, rowsFrom, type RecallRow } from './toRead';

export const TO_READ = 'recalls-to-read';

export interface ToReadDefinition {
  type: typeof TO_READ;
  dataMapping: Record<'recall' | 'title' | 'outcome', AgWidgetFieldReference[]>;
  format?: AgWidgetDataFormat<unknown>;
}

export interface RecallRegistry extends AgBaseRegistry {
  widgets: readonly (AgDefaultWidgetDefinition | AgWidgetDefinition<typeof TO_READ, ToReadDefinition>)[];
}

function RecallsToRead(props: AgWidgetParams<ToReadDefinition>) {
  const [rows, setRows] = useState<RecallRow[]>([]);
  const [failed, setFailed] = useState(false);

  // Studio hands this component new props whenever its data should be read again, such as a filter changing.
  useEffect(() => {
    const { widgetApi, dataMapping } = props;
    const recall = dataMapping.recall?.[0];
    const title = dataMapping.title?.[0];
    const outcome = dataMapping.outcome?.[0];
    if (!recall || !title || !outcome) {
      widgetApi.setDisplayState('incompleteDataMapping');
      return;
    }
    let current = true;
    widgetApi.setDisplayState('loading', { prominent: true });
    widgetApi
      .getData({ fields: [recall, title, outcome] })
      .then(({ results }) => {
        if (!current) return;
        const read = rowsFrom(results, { recall: recall.key, title: title.key, outcome: outcome.key });
        const found = recallsToRead(read ?? []);
        setRows(found);
        setFailed(read === null);
        widgetApi.setDisplayState(read === null || found.length > 0 ? 'displayed' : 'noData');
      })
      .catch(() => {
        if (!current) return;
        setRows([]);
        setFailed(true);
        widgetApi.setDisplayState('displayed');
      });
    return () => {
      current = false;
    };
  }, [props]);

  if (failed) return <p data-testid="studio-to-read-failed">This list couldn&apos;t be read. Please reload the page.</p>;

  return (
    <ul className="studio-to-read" data-testid="studio-to-read">
      {rows.map((r) => (
        <li key={r.recallNumber}>
          <a href={recallPage(r.recallNumber)} target="_blank" rel="noopener">
            <OutcomeBadge outcome={r.outcome} />
            <span className="studio-to-read-title">{r.title}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}

export const recallsToReadWidget: AgWidgetDefinition<typeof TO_READ, ToReadDefinition> = {
  id: TO_READ,
  label: 'Recalls to read',
  dataMapping: {
    recall: { type: 'field', supportedRoles: ['category'], required: true },
    title: { type: 'field', supportedRoles: ['category'], required: true },
    outcome: { type: 'field', supportedRoles: ['category'], required: true },
  },
  form: (params) =>
    params.createDefaults({
      dataMappingItems: [
        { key: 'recall', label: 'Recall number' },
        { key: 'title', label: 'Title' },
        { key: 'outcome', label: 'Outcome' },
      ],
    }),
  comp: RecallsToRead,
  defaultSize: { width: 420, height: 320 },
  minSize: { width: 260, height: 180 },
};

import type { ReportRow } from './report-service.js';

export const REPORT_EXPORT_COLUMNS = [
  { key: 'activityId', label: 'ID активности' }, { key: 'kindLabel', label: 'Тип' }, { key: 'title', label: 'Активность' },
  { key: 'stageLabel', label: 'Стадия' }, { key: 'ownerName', label: 'Ответственный' }, { key: 'organizationName', label: 'Организация' },
  { key: 'personName', label: 'Человек' }, { key: 'originLabel', label: 'Источник заявки' }, { key: 'createdAt', label: 'Создана', date: true },
  { key: 'updatedAt', label: 'Изменена', date: true }, { key: 'closed', label: 'Закрыта' }, { key: 'productNames', label: 'Продукты' },
  { key: 'programNames', label: 'Учебные программы' },
  { key: 'requestedPlaces', label: 'Заявлено мест' }, { key: 'requestedPlacesRecorded', label: 'Места указаны' },
  { key: 'enrollmentFactCount', label: 'Факты зачисления LMS' }, { key: 'learningStartedFactCount', label: 'Факты начала LMS' },
  { key: 'learningCompletedFactCount', label: 'Факты завершения LMS' }, { key: 'learningFactsSource', label: 'Источник учебных фактов' },
  { key: 'lastLearningFactAt', label: 'Последний факт LMS', date: true },
] as const satisfies readonly { key: keyof ReportRow; label: string; date?: boolean }[];

export type ReportExportColumnKey = typeof REPORT_EXPORT_COLUMNS[number]['key'];

export function isReportExportColumnKey(value: unknown): value is ReportExportColumnKey {
  return typeof value === 'string' && REPORT_EXPORT_COLUMNS.some((column) => column.key === value);
}

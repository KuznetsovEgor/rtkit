export function russianNounForm(count: number, one: string, few: string, many: string) {
  const absoluteCount = Math.abs(Math.trunc(count));
  const lastTwoDigits = absoluteCount % 100;
  if (lastTwoDigits >= 11 && lastTwoDigits <= 14) return many;

  const lastDigit = absoluteCount % 10;
  if (lastDigit === 1) return one;
  if (lastDigit >= 2 && lastDigit <= 4) return few;
  return many;
}

export function formatRussianCount(count: number, one: string, few: string, many: string) {
  return `${count.toLocaleString('ru-RU')} ${russianNounForm(count, one, few, many)}`;
}

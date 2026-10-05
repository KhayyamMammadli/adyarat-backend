export const validVoen = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{10}$/.test(value) && !/^0+$/.test(value);
export const validEmail = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= 254 &&
  /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(
    value,
  ) &&
  !value.includes('..');
export const validPhone = (value: string): boolean =>
  /^\+?[\d\s()-]{7,25}$/.test(value) && /^\d{7,15}$/.test(value.replace(/\D/g, ''));
export function validCoordinates(value: any): boolean {
  return (
    typeof value?.latitude === 'number' &&
    typeof value?.longitude === 'number' &&
    Number.isFinite(value.latitude) &&
    Number.isFinite(value.longitude) &&
    Math.abs(value.latitude) <= 90 &&
    Math.abs(value.longitude) <= 180
  );
}
export function mapsLink(job: any): string {
  return validCoordinates(job)
    ? `https://www.google.com/maps/search/?api=1&query=${job.latitude},${job.longitude}`
    : '';
}
export function distanceKm(a: any, b: any): number {
  if (!validCoordinates(a) || !validCoordinates(b)) return Infinity;
  const rad = (n: number) => (n * Math.PI) / 180;
  const h =
    Math.sin(rad(b.latitude - a.latitude) / 2) ** 2 +
    Math.cos(rad(a.latitude)) *
      Math.cos(rad(b.latitude)) *
      Math.sin(rad(b.longitude - a.longitude) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
}

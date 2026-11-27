export function localDay(value) {
  const day = new Date(value);
  const pad = value => String(value).padStart(2, '0');
  return [day.getFullYear(), pad(day.getMonth() + 1), pad(day.getDate())].join('-');
}

export function shiftDay(value, days) {
  const day = new Date(value);
  day.setHours(12, 0, 0, 0);
  day.setDate(day.getDate() + days);
  return day;
}

export function weekSchedule(anchor, jobs) {
  const monday = shiftDay(anchor, -((anchor.getDay() + 6) % 7));
  const days = Array.from({ length: 7 }, (_, index) => {
    const day = shiftDay(monday, index);
    return { day, key: localDay(day), jobs: [] };
  });
  const byDay = new Map(days.map(day => [day.key, day.jobs]));
  for (const job of jobs) {
    if (job.scheduledAt) byDay.get(localDay(job.scheduledAt))?.push(job);
  }
  for (const day of days) day.jobs.sort(compareSchedule);
  return days;
}

export function compareSchedule(left, right) {
  return (left.scheduledAt ? Date.parse(left.scheduledAt) : Infinity) -
    (right.scheduledAt ? Date.parse(right.scheduledAt) : Infinity) ||
    left.createdAt.localeCompare(right.createdAt);
}

export function isPending(job) {
  return job.status === 'queued' || job.status === 'handed_off';
}

export function isPastSchedule(job, now) {
  return isPending(job) && Boolean(job.scheduledAt) && Date.parse(job.scheduledAt) < +now;
}

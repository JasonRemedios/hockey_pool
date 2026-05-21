const NHL_API_BASE = "https://api-web.nhle.com";
const TICKET_DAYS = new Set([5, 6, 0]);

export async function getCurrentTicketSchedule() {
  let ticketStartDate = getTicketFridayDate(new Date());

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const schedule = await fetchSchedule(formatDateForApi(ticketStartDate));
    const firstGame = getFirstTicketGame(schedule);
    const firstStart = firstGame?.startTimeUTC ? new Date(firstGame.startTimeUTC) : null;

    if (!firstStart || firstStart > new Date()) {
      return normalizeSchedule(schedule);
    }

    ticketStartDate = addDays(ticketStartDate, 7);
  }

  return normalizeSchedule(await fetchSchedule(formatDateForApi(ticketStartDate)));
}

export async function getPreviousTicketSchedule() {
  let ticketStartDate = addDays(getTicketFridayDate(new Date()), -7);
  let schedule = normalizeSchedule(await fetchSchedule(formatDateForApi(ticketStartDate)));

  for (let attempt = 0; attempt < 8 && !schedule.games.length; attempt += 1) {
    ticketStartDate = addDays(ticketStartDate, -7);
    schedule = normalizeSchedule(await fetchSchedule(formatDateForApi(ticketStartDate)));
  }

  return schedule;
}

export function scoreTicket(ticket, games) {
  const finalGames = games.filter((game) => game.winnerTeam);
  const correct = finalGames.filter((game) => ticket.picks[String(game.id)] === game.winnerTeam).length;

  return {
    correct,
    possible: finalGames.length,
  };
}

async function fetchSchedule(startDate) {
  const response = await fetch(`${NHL_API_BASE}/v1/schedule/${startDate}`);

  if (!response.ok) {
    throw new Error(`NHL schedule request failed (${response.status}).`);
  }

  return response.json();
}

function normalizeSchedule(schedule) {
  const days = (schedule?.gameWeek || [])
    .filter((day) => TICKET_DAYS.has(new Date(`${day.date}T12:00:00`).getDay()))
    .map((day) => ({
      date: day.date,
      label: formatDateLabel(day.date),
      games: (day.games || [])
        .filter((game) => game.startTimeUTC && game.awayTeam && game.homeTeam)
        .map((game) => normalizeGame(game)),
    }))
    .filter((day) => day.games.length);

  return {
    ticketId: days[0]?.date?.replaceAll("-", "") || "",
    days,
    games: days.flatMap((day) => day.games),
  };
}

function normalizeGame(game) {
  const awayScore = Number(game.awayTeam?.score);
  const homeScore = Number(game.homeTeam?.score);
  const isFinal = ["OFF", "FINAL"].includes(game.gameState);
  let winnerTeam = null;

  if (isFinal && Number.isFinite(awayScore) && Number.isFinite(homeScore) && awayScore !== homeScore) {
    winnerTeam = awayScore > homeScore ? formatTeam(game.awayTeam) : formatTeam(game.homeTeam);
  }

  return {
    id: game.id,
    awayTeam: formatTeam(game.awayTeam),
    homeTeam: formatTeam(game.homeTeam),
    startTimeUTC: game.startTimeUTC,
    startLabel: formatStartLabel(game.startTimeUTC),
    gameState: game.gameState,
    winnerTeam,
  };
}

function getTicketFridayDate(date) {
  const ticketDate = new Date(date);
  ticketDate.setHours(12, 0, 0, 0);
  ticketDate.setDate(ticketDate.getDate() + (5 - ticketDate.getDay()));
  return ticketDate;
}

function getFirstTicketGame(schedule) {
  return (schedule?.gameWeek || [])
    .filter((day) => TICKET_DAYS.has(new Date(`${day.date}T12:00:00`).getDay()))
    .flatMap((day) => day.games || [])[0];
}

function addDays(date, days) {
  const nextDate = new Date(date);
  nextDate.setDate(nextDate.getDate() + days);
  return nextDate;
}

function formatDateForApi(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatTeam(team) {
  const place = team.placeName?.default || team.commonName?.default || team.abbrev || "";
  return place.replace("Montréal", "Montreal").toUpperCase();
}

function formatDateLabel(date) {
  return new Intl.DateTimeFormat("en-CA", {
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(new Date(`${date}T12:00:00`));
}

function formatStartLabel(startTimeUTC) {
  return new Intl.DateTimeFormat("en-CA", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(startTimeUTC));
}

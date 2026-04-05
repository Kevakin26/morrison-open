import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface GolferScore {
  name: string
  position: string
  total_score: number | null
  to_par: number | null
  today: string | null
  thru: string | null
  r1: number | null
  r2: number | null
  r3: number | null
  r4: number | null
  status: string
}

interface FetchResult {
  source: string
  golfers: GolferScore[]
  currentRound: number | null
  cutLine: number | null
}

// Normalize golfer names for matching: lowercase, trim, remove accents
function normalizeName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip accents
    .replace(/\s+/g, ' ')
}

function parseScore(val: unknown): number | null {
  if (val === null || val === undefined || val === '' || val === '-' || val === 'E') return null
  const n = Number(val)
  return isNaN(n) ? null : n
}

function parseToPar(val: unknown): number | null {
  if (val === null || val === undefined || val === '') return null
  if (val === 'E' || val === 'Even' || val === 'even') return 0
  const str = String(val).replace('+', '')
  const n = Number(str)
  return isNaN(n) ? null : n
}

// ---------- Primary: masters.com ----------
async function fetchFromMasters(): Promise<FetchResult> {
  const url = 'https://www.masters.com/en_US/scores/feeds/2026/scores.json'
  const res = await fetch(url, {
    headers: { 'User-Agent': 'MorrisonOpen/1.0' },
  })

  if (!res.ok) {
    throw new Error(`masters.com returned ${res.status}`)
  }

  const json = await res.json()
  const players: unknown[] = json?.data?.player ?? json?.players ?? []

  if (!Array.isArray(players) || players.length === 0) {
    throw new Error('No player data found in masters.com response')
  }

  let currentRound: number | null = null
  let cutLine: number | null = null

  // Attempt to read round info from top-level data
  if (json?.data?.currentRound) {
    currentRound = Number(json.data.currentRound) || null
  }
  if (json?.data?.cutLine !== undefined) {
    cutLine = parseToPar(json.data.cutLine)
  }

  const golfers: GolferScore[] = players.map((p: Record<string, unknown>) => {
    const first = String(p.first_name ?? p.firstName ?? '')
    const last = String(p.last_name ?? p.lastName ?? '')
    const name = `${first} ${last}`.trim()

    const rounds = (p.rounds ?? p.round ?? []) as Record<string, unknown>[]

    return {
      name,
      position: String(p.pos ?? p.position ?? ''),
      total_score: parseScore(p.total ?? p.totalScore),
      to_par: parseToPar(p.topar ?? p.toPar ?? p.today_total ?? p.overallPar),
      today: p.today != null ? String(p.today) : null,
      thru: p.thru != null ? String(p.thru) : null,
      r1: parseScore(rounds?.[0]?.score ?? rounds?.[0]?.strokes ?? p.r1 ?? p.round1),
      r2: parseScore(rounds?.[1]?.score ?? rounds?.[1]?.strokes ?? p.r2 ?? p.round2),
      r3: parseScore(rounds?.[2]?.score ?? rounds?.[2]?.strokes ?? p.r3 ?? p.round3),
      r4: parseScore(rounds?.[3]?.score ?? rounds?.[3]?.strokes ?? p.r4 ?? p.round4),
      status: String(p.status ?? 'active'),
    }
  })

  return { source: 'masters.com', golfers, currentRound, cutLine }
}

// ---------- Fallback: ESPN ----------
async function fetchFromESPN(): Promise<FetchResult> {
  const url =
    'https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard'
  const res = await fetch(url)

  if (!res.ok) {
    throw new Error(`ESPN returned ${res.status}`)
  }

  const json = await res.json()

  // ESPN structure: events[0].competitions[0].competitors[]
  const events = json?.events ?? []
  const mastersEvent = events.find(
    (e: Record<string, unknown>) =>
      String(e.name ?? '').toLowerCase().includes('masters') ||
      String(e.shortName ?? '').toLowerCase().includes('masters')
  ) ?? events[0]

  if (!mastersEvent) {
    throw new Error('No Masters event found on ESPN')
  }

  const competition = mastersEvent.competitions?.[0]
  const competitors: unknown[] = competition?.competitors ?? []

  if (!Array.isArray(competitors) || competitors.length === 0) {
    throw new Error('No competitor data in ESPN response')
  }

  let currentRound: number | null = null
  let cutLine: number | null = null

  if (competition?.status?.period) {
    currentRound = Number(competition.status.period) || null
  }

  const golfers: GolferScore[] = competitors.map(
    (c: Record<string, unknown>) => {
      const athlete = c.athlete as Record<string, unknown> | undefined
      const name = String(athlete?.displayName ?? athlete?.shortName ?? '')

      const stats = (c.statistics ?? c.stats ?? []) as Record<string, unknown>[]
      const linescores = (c.linescores ?? []) as Record<string, unknown>[]

      // ESPN provides score relative to par in different fields
      const scoreVal = c.score as string | undefined
      const toPar = parseToPar(scoreVal ?? c.toPar)

      return {
        name,
        position: String(c.place ?? c.position ?? ''),
        total_score: parseScore(c.totalStrokes ?? stats?.[0]?.value),
        to_par: toPar,
        today: c.todayScore != null ? String(c.todayScore) : null,
        thru: c.thru != null ? String(c.thru) : null,
        r1: parseScore(linescores?.[0]?.value ?? linescores?.[0]?.score),
        r2: parseScore(linescores?.[1]?.value ?? linescores?.[1]?.score),
        r3: parseScore(linescores?.[2]?.value ?? linescores?.[2]?.score),
        r4: parseScore(linescores?.[3]?.value ?? linescores?.[3]?.score),
        status: String(c.status?.type?.description ?? 'active').toLowerCase(),
      }
    }
  )

  return { source: 'espn', golfers, currentRound, cutLine }
}

// ---------- Main handler ----------
Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const supabase = createClient(supabaseUrl, supabaseKey)

  let result: FetchResult | null = null
  let error: string | null = null

  // 1) Try masters.com
  try {
    result = await fetchFromMasters()
    console.log(`Fetched ${result.golfers.length} golfers from masters.com`)
  } catch (e) {
    console.warn('masters.com failed:', (e as Error).message)
  }

  // 2) Fallback to ESPN
  if (!result) {
    try {
      result = await fetchFromESPN()
      console.log(`Fetched ${result.golfers.length} golfers from ESPN`)
    } catch (e) {
      console.warn('ESPN failed:', (e as Error).message)
      error = `Both sources failed. ESPN: ${(e as Error).message}`
    }
  }

  // 3) If both failed, log and return error
  if (!result) {
    await supabase.from('score_fetch_logs').insert({
      source: 'none',
      status: 'error',
      golfers_updated: 0,
      details: error,
      fetched_at: new Date().toISOString(),
    })

    return new Response(JSON.stringify({ success: false, error }), {
      status: 502,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  // 4) Load golfer list from DB for name matching
  const { data: dbGolfers, error: golferErr } = await supabase
    .from('golfers')
    .select('id, name')

  if (golferErr || !dbGolfers) {
    const msg = `Failed to load golfers table: ${golferErr?.message}`
    await supabase.from('score_fetch_logs').insert({
      source: result.source,
      status: 'error',
      golfers_updated: 0,
      details: msg,
      fetched_at: new Date().toISOString(),
    })

    return new Response(JSON.stringify({ success: false, error: msg }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  // Build lookup map: normalized name -> golfer id
  const nameMap = new Map<string, string>()
  for (const g of dbGolfers) {
    nameMap.set(normalizeName(g.name), g.id)
  }

  // 5) Upsert scores
  let updatedCount = 0
  const unmatchedNames: string[] = []

  for (const golfer of result.golfers) {
    const normalized = normalizeName(golfer.name)
    const golferId = nameMap.get(normalized)

    if (!golferId) {
      // Try last-name-first matching: "Woods, Tiger" -> "Tiger Woods"
      const commaFlipped = golfer.name.includes(',')
        ? golfer.name
            .split(',')
            .map((s) => s.trim())
            .reverse()
            .join(' ')
        : null
      const flippedId = commaFlipped
        ? nameMap.get(normalizeName(commaFlipped))
        : undefined

      if (!flippedId) {
        unmatchedNames.push(golfer.name)
        continue
      }

      // Matched via comma flip
      const { error: upsertErr } = await supabase
        .from('golfer_scores')
        .upsert(
          {
            golfer_id: flippedId,
            position: golfer.position || null,
            total_score: golfer.total_score,
            to_par: golfer.to_par,
            today: golfer.today,
            thru: golfer.thru,
            r1: golfer.r1,
            r2: golfer.r2,
            r3: golfer.r3,
            r4: golfer.r4,
            status: golfer.status,
            is_manual: false,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'golfer_id' }
        )

      if (!upsertErr) updatedCount++
      continue
    }

    const { error: upsertErr } = await supabase
      .from('golfer_scores')
      .upsert(
        {
          golfer_id: golferId,
          position: golfer.position || null,
          total_score: golfer.total_score,
          to_par: golfer.to_par,
          today: golfer.today,
          thru: golfer.thru,
          r1: golfer.r1,
          r2: golfer.r2,
          r3: golfer.r3,
          r4: golfer.r4,
          status: golfer.status,
          is_manual: false,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'golfer_id' }
      )

    if (!upsertErr) updatedCount++
  }

  // 6) Update tournament info (current round, cut line)
  if (result.currentRound || result.cutLine !== null) {
    const tournamentUpdate: Record<string, unknown> = {}
    if (result.currentRound) {
      tournamentUpdate.current_round = result.currentRound
    }
    if (result.cutLine !== null && result.currentRound && result.currentRound >= 2) {
      tournamentUpdate.cut_line = result.cutLine
    }

    if (Object.keys(tournamentUpdate).length > 0) {
      // Update the active tournament (most recent one)
      const { data: tournaments } = await supabase
        .from('tournaments')
        .select('id')
        .order('year', { ascending: false })
        .limit(1)

      if (tournaments && tournaments.length > 0) {
        await supabase
          .from('tournaments')
          .update(tournamentUpdate)
          .eq('id', tournaments[0].id)
      }
    }
  }

  // 7) Log result
  await supabase.from('score_fetch_logs').insert({
    source: result.source,
    status: 'success',
    golfers_updated: updatedCount,
    details:
      unmatchedNames.length > 0
        ? `Unmatched: ${unmatchedNames.join(', ')}`
        : null,
    fetched_at: new Date().toISOString(),
  })

  const responseBody = {
    success: true,
    source: result.source,
    golfers_updated: updatedCount,
    total_fetched: result.golfers.length,
    unmatched: unmatchedNames,
    current_round: result.currentRound,
  }

  console.log('Score fetch complete:', JSON.stringify(responseBody))

  return new Response(JSON.stringify(responseBody), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
})

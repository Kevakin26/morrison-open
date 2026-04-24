<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { supabase } from '@/lib/supabase'
import type {
  WeeklyEventRow as WeeklyEvent,
  LeaderboardSnapshotRow as Snapshot,
  WeeklyResultRow as Result,
  ProfileRow as Profile,
  PickRow as Pick,
} from '@/types/database'
import type { RealtimeChannel } from '@supabase/supabase-js'

const event = ref<WeeklyEvent | null>(null)
const snapshots = ref<Snapshot[]>([])
const results = ref<Result[]>([])
const picks = ref<Pick[]>([])
const members = ref<Profile[]>([])
const loading = ref(true)
const tab = ref<'ours' | 'field'>('ours')

let channels: RealtimeChannel[] = []

const nameById = computed(() => {
  const m = new Map<string, string>()
  for (const p of members.value) m.set(p.id, (p.display_name ?? '').trim() || 'Unknown')
  return m
})

const statusLabel = (s: string) => ({
  active: '',
  cut: 'CUT',
  wd: 'WD',
  dq: 'DQ',
} as Record<string, string>)[s] || ''

const ourRows = computed(() => {
  // Prefer weekly_results (has ranks/points already); fall back to snapshots if draft just completed
  if (results.value.length === 5) {
    return [...results.value].sort((a, b) => a.rank_in_league - b.rank_in_league || a.points - b.points)
  }
  // derive mock rows from picks + snapshots so users can see something during live play before recompute
  const byGolfer = new Map(snapshots.value.map(s => [s.golfer_espn_id, s]))
  return picks.value.map(p => {
    const s = byGolfer.get(p.golfer_espn_id)
    return {
      id: p.id,
      event_id: p.event_id,
      user_id: p.user_id,
      golfer_espn_id: p.golfer_espn_id,
      golfer_name: p.golfer_name,
      position_display: s?.position_display ?? null,
      position_numeric: s?.position_numeric ?? null,
      total_to_par_display: s?.total_to_par_display ?? null,
      status: s?.status ?? 'active',
      rank_in_league: 0,
      points: 0,
      is_final: false,
      updated_at: s?.updated_at ?? p.created_at,
    } as Result
  }).sort((a, b) => {
    const ap = a.position_numeric ?? 9999
    const bp = b.position_numeric ?? 9999
    return ap - bp
  })
})

async function load() {
  loading.value = true
  const { data: events } = await supabase
    .from('weekly_events')
    .select('*')
    .in('status', ['drafting', 'in_progress', 'completed'])
    .order('start_date', { ascending: false })
    .limit(1)
  event.value = (events?.[0] ?? null) as WeeklyEvent | null

  if (!event.value) { loading.value = false; return }

  const [{ data: snaps }, { data: res }, { data: pks }, { data: season }] = await Promise.all([
    supabase.from('leaderboard_snapshots').select('*').eq('event_id', event.value.id).order('position_numeric', { ascending: true, nullsFirst: false }).limit(250),
    supabase.from('weekly_results').select('*').eq('event_id', event.value.id),
    supabase.from('picks').select('*').eq('event_id', event.value.id),
    supabase.from('seasons').select('id').eq('status', 'active').single(),
  ])
  snapshots.value = (snaps ?? []) as Snapshot[]
  results.value = (res ?? []) as Result[]
  picks.value = (pks ?? []) as Pick[]
  if (season) {
    const { data: lm } = await supabase
      .from('league_members')
      .select('profiles:profiles!inner(id,display_name,created_at)')
      .eq('season_id', season.id)
    members.value = (lm ?? []).map((r: any) => r.profiles).filter(Boolean) as Profile[]
  }
  loading.value = false
}

function subscribe() {
  if (!event.value) return
  channels.push(
    supabase.channel(`live:${event.value.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'leaderboard_snapshots', filter: `event_id=eq.${event.value.id}` }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'weekly_results', filter: `event_id=eq.${event.value.id}` }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'picks', filter: `event_id=eq.${event.value.id}` }, load)
      .subscribe()
  )
}

onMounted(async () => {
  await load()
  subscribe()
})
onUnmounted(() => {
  channels.forEach(c => supabase.removeChannel(c))
  channels = []
})
watch(() => event.value?.id, (id, prev) => {
  if (id && id !== prev) {
    channels.forEach(c => supabase.removeChannel(c))
    channels = []
    subscribe()
  }
})
</script>

<template>
  <div class="max-w-3xl mx-auto p-4 space-y-4">
    <div v-if="loading" class="text-center text-gray-500 py-12">Loading live board…</div>

    <div v-else-if="!event" class="text-center py-12 bg-white rounded-xl shadow">
      <p class="text-lg font-semibold text-dark">No active event</p>
    </div>

    <template v-else>
      <div class="bg-augusta-gradient text-white rounded-xl p-4 shadow">
        <p class="text-xs uppercase tracking-widest text-cream/70">Live Board</p>
        <h2 class="text-xl font-bold">{{ event.name }}</h2>
        <p class="text-sm text-cream/80">{{ event.start_date }} → {{ event.end_date }} · {{ event.status.replace('_', ' ') }}</p>
      </div>

      <!-- Tabs -->
      <div class="flex rounded-xl bg-white shadow overflow-hidden">
        <button
          @click="tab = 'ours'"
          class="flex-1 py-3 text-sm font-semibold uppercase tracking-wider"
          :class="tab === 'ours' ? 'bg-augusta text-white' : 'text-gray-600'"
        >Our Picks</button>
        <button
          @click="tab = 'field'"
          class="flex-1 py-3 text-sm font-semibold uppercase tracking-wider"
          :class="tab === 'field' ? 'bg-augusta text-white' : 'text-gray-600'"
        >Field</button>
      </div>

      <!-- Our picks -->
      <div v-if="tab === 'ours'" class="bg-white rounded-xl shadow overflow-hidden">
        <div v-if="picks.length === 0" class="p-8 text-center text-gray-500 text-sm">
          No picks yet for this week.
        </div>
        <ul v-else class="divide-y">
          <li v-for="r in ourRows" :key="r.id" class="p-4 flex items-center justify-between gap-3">
            <div class="flex items-center gap-3 min-w-0">
              <span class="font-score text-sm text-gray-500 w-10 flex-shrink-0">
                {{ r.position_display || statusLabel(r.status) || '—' }}
              </span>
              <div class="min-w-0">
                <p class="font-semibold text-dark truncate">{{ r.golfer_name }}</p>
                <p class="text-xs text-gray-500">{{ nameById.get(r.user_id) || '…' }}</p>
              </div>
            </div>
            <div class="text-right flex-shrink-0">
              <p class="font-score font-bold" :class="r.status !== 'active' ? 'text-red-500' : 'text-dark'">
                {{ r.total_to_par_display || '—' }}
              </p>
              <p v-if="r.points > 0" class="text-xs">
                <span class="font-bold text-augusta">{{ r.points }}</span>
                <span class="text-gray-400"> pts</span>
              </p>
            </div>
          </li>
        </ul>
      </div>

      <!-- Full field -->
      <div v-if="tab === 'field'" class="bg-white rounded-xl shadow overflow-hidden">
        <div v-if="snapshots.length === 0" class="p-8 text-center text-gray-500 text-sm">
          ESPN hasn't published the field yet.
        </div>
        <ul v-else class="divide-y max-h-[70vh] overflow-y-auto">
          <li v-for="g in snapshots" :key="g.golfer_espn_id" class="p-3 flex items-center justify-between">
            <div class="flex items-center gap-3">
              <span class="font-score text-sm text-gray-500 w-10">{{ g.position_display || statusLabel(g.status) || '—' }}</span>
              <p class="font-semibold text-dark">{{ g.golfer_name }}</p>
            </div>
            <p class="font-score text-sm" :class="g.status !== 'active' ? 'text-red-500' : 'text-dark'">
              {{ g.total_to_par_display || '—' }}
            </p>
          </li>
        </ul>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/auth'
import type {
  WeeklyEventRow as WeeklyEvent,
  WeeklyResultRow as Result,
  ProfileRow as Profile,
} from '@/types/database'

const auth = useAuthStore()

const events = ref<WeeklyEvent[]>([])
const results = ref<Result[]>([])
const members = ref<Profile[]>([])
const loading = ref(true)
const onlyMe = ref(false)

const nameById = computed(() => {
  const m = new Map<string, string>()
  for (const p of members.value) m.set(p.id, (p.display_name ?? '').trim() || 'Unknown')
  return m
})

const groupedByEvent = computed(() => {
  const map = new Map<string, Result[]>()
  for (const r of results.value) {
    if (onlyMe.value && r.user_id !== auth.user?.id) continue
    if (!map.has(r.event_id)) map.set(r.event_id, [])
    map.get(r.event_id)!.push(r)
  }
  return events.value
    .map(ev => ({ event: ev, rows: (map.get(ev.id) ?? []).sort((a, b) => a.rank_in_league - b.rank_in_league) }))
    .filter(g => g.rows.length > 0)
})

const usedGolfersByUser = computed(() => {
  const m = new Map<string, { name: string; eventName: string }[]>()
  for (const r of results.value) {
    const list = m.get(r.user_id) ?? []
    const ev = events.value.find(e => e.id === r.event_id)
    list.push({ name: r.golfer_name, eventName: ev?.short_name || ev?.name || '—' })
    m.set(r.user_id, list)
  }
  return m
})

async function load() {
  const [{ data: evs }, { data: res }, { data: season }] = await Promise.all([
    supabase.from('weekly_events').select('*').order('start_date', { ascending: false }),
    supabase.from('weekly_results').select('*'),
    supabase.from('seasons').select('id').eq('status', 'active').single(),
  ])
  events.value = (evs ?? []) as WeeklyEvent[]
  results.value = (res ?? []) as Result[]
  if (season) {
    const { data: lm } = await supabase
      .from('league_members')
      .select('profiles:profiles!inner(id,display_name,created_at)')
      .eq('season_id', season.id)
    members.value = (lm ?? []).map((r: any) => r.profiles).filter(Boolean) as Profile[]
  }
  loading.value = false
}

onMounted(load)
</script>

<template>
  <div class="max-w-3xl mx-auto p-4 space-y-4">
    <div class="bg-augusta-gradient text-white rounded-xl p-4 shadow">
      <p class="text-xs uppercase tracking-widest text-cream/70">History</p>
      <h2 class="text-2xl font-bold">Week-by-Week</h2>
    </div>

    <div class="flex items-center gap-2">
      <button
        @click="onlyMe = false"
        class="px-3 py-1.5 rounded-lg text-sm font-semibold"
        :class="!onlyMe ? 'bg-augusta text-white' : 'bg-white border text-gray-600'"
      >Everyone</button>
      <button
        @click="onlyMe = true"
        class="px-3 py-1.5 rounded-lg text-sm font-semibold"
        :class="onlyMe ? 'bg-augusta text-white' : 'bg-white border text-gray-600'"
      >Just Me</button>
    </div>

    <div v-if="loading" class="text-center text-gray-500 py-12">Loading…</div>

    <div v-else-if="groupedByEvent.length === 0" class="text-center py-12 bg-white rounded-xl shadow text-gray-500 text-sm">
      No completed weeks yet.
    </div>

    <div v-for="g in groupedByEvent" :key="g.event.id" class="bg-white rounded-xl shadow overflow-hidden">
      <div class="p-4 border-b bg-gray-50">
        <p class="font-semibold text-dark">{{ g.event.name }}</p>
        <p class="text-xs text-gray-500">{{ g.event.start_date }} → {{ g.event.end_date }} · {{ g.event.status.replace('_', ' ') }}</p>
      </div>
      <ul class="divide-y">
        <li v-for="r in g.rows" :key="r.id" class="p-3 flex items-center justify-between">
          <div class="flex items-center gap-3">
            <span class="font-score text-gray-500 w-8">#{{ r.rank_in_league }}</span>
            <div>
              <p class="font-semibold text-dark">{{ r.golfer_name }}</p>
              <p class="text-xs text-gray-500">{{ nameById.get(r.user_id) || '…' }} · {{ r.position_display || r.status.toUpperCase() }}</p>
            </div>
          </div>
          <div class="text-right">
            <p class="font-score font-bold text-augusta">{{ r.points }} <span class="text-xs text-gray-400 font-sans">pts</span></p>
          </div>
        </li>
      </ul>
    </div>

    <!-- Used golfers -->
    <div v-if="!loading" class="bg-white rounded-xl shadow p-4">
      <p class="text-xs uppercase tracking-widest text-gray-500 mb-2">Golfers Used This Season</p>
      <div v-for="m in members" :key="m.id" class="mb-3">
        <p class="font-semibold text-sm text-dark">{{ m.display_name.trim() }}</p>
        <div class="flex flex-wrap gap-1 mt-1">
          <span v-for="(g, i) in usedGolfersByUser.get(m.id) ?? []" :key="i" class="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-700">
            {{ g.name }}
          </span>
          <span v-if="!(usedGolfersByUser.get(m.id)?.length)" class="text-xs text-gray-400">None yet</span>
        </div>
      </div>
    </div>
  </div>
</template>

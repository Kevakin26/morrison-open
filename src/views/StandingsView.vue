<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { supabase } from '@/lib/supabase'
import type { SeasonStandingRow as Standing } from '@/types/database'
import type { RealtimeChannel } from '@supabase/supabase-js'

const standings = ref<Standing[]>([])
const loading = ref(true)
let channel: RealtimeChannel | null = null

async function load() {
  const { data } = await supabase.from('season_standings').select('*')
  standings.value = (data ?? []) as Standing[]
  loading.value = false
}

onMounted(() => {
  load()
  channel = supabase.channel('standings')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'weekly_results' }, load)
    .subscribe()
})
onUnmounted(() => { if (channel) supabase.removeChannel(channel) })
</script>

<template>
  <div class="max-w-3xl mx-auto p-4 space-y-4">
    <div class="bg-augusta-gradient text-white rounded-xl p-4 shadow">
      <p class="text-xs uppercase tracking-widest text-cream/70">Season Standings</p>
      <h2 class="text-2xl font-bold">2026 Morrison Open</h2>
      <p class="text-xs text-cream/70 mt-1">Lower score wins. Tiebreaks: most outright wins (W), then 1sts, 2nds, 3rds.</p>
    </div>

    <div v-if="loading" class="text-center text-gray-500 py-12">Loading…</div>

    <div v-else class="bg-white rounded-xl shadow overflow-hidden">
      <div class="grid grid-cols-[24px_minmax(0,1fr)_44px_28px_28px_28px_28px_28px_30px] gap-x-1 py-2 px-3 bg-gray-50 text-xs font-semibold text-gray-500 uppercase tracking-wider">
        <div class="col-span-1">#</div>
        <div class="col-span-1">Player</div>
        <div class="col-span-1 text-center">Pts</div>
        <div class="col-span-1 text-center" title="Outright tournament wins">W</div>
        <div class="col-span-1 text-center">1st</div>
        <div class="col-span-1 text-center">2nd</div>
        <div class="col-span-1 text-center">3rd</div>
        <div class="col-span-1 text-center">4th</div>
        <div class="col-span-1 text-center" title="Weeks played">Wks</div>
      </div>
      <ul class="divide-y">
        <li v-for="(s, i) in standings" :key="s.user_id" class="grid grid-cols-[24px_minmax(0,1fr)_44px_28px_28px_28px_28px_28px_30px] gap-x-1 py-3 px-3 items-center text-sm">
          <div class="col-span-1 font-score text-gray-500">{{ i + 1 }}</div>
          <div class="col-span-1 font-semibold text-dark truncate">{{ s.display_name }}</div>
          <div class="col-span-1 text-center font-score font-bold text-augusta">{{ s.total_points }}</div>
          <div class="col-span-1 text-center font-score font-bold text-gold">{{ s.wins }}</div>
          <div class="col-span-1 text-center font-score text-gray-600">{{ s.firsts }}</div>
          <div class="col-span-1 text-center font-score text-gray-600">{{ s.seconds }}</div>
          <div class="col-span-1 text-center font-score text-gray-600">{{ s.thirds }}</div>
          <div class="col-span-1 text-center font-score text-gray-600">{{ s.fourths }}</div>
          <div class="col-span-1 text-center font-score text-gray-500">{{ s.weeks_played }}</div>
        </li>
      </ul>
    </div>

    <div class="bg-white rounded-xl p-4 shadow text-sm text-gray-600 space-y-2">
      <p class="font-semibold text-dark">Scoring</p>
      <ul class="space-y-1 text-xs">
        <li>🏆 Pick wins the tournament outright: <span class="font-bold">0 pts</span></li>
        <li>🥇 1st among our 5 picks: <span class="font-bold">1 pt</span></li>
        <li>🥈 2nd: <span class="font-bold">2 pts</span></li>
        <li>🥉 3rd: <span class="font-bold">3 pts</span></li>
        <li>4th, 5th, or missed cut / WD / DQ: <span class="font-bold">4 pts</span></li>
        <li>Ties share the better rank (e.g. T-1st = 1, 1, then 3).</li>
      </ul>
    </div>
  </div>
</template>

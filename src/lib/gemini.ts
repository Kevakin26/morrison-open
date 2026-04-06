const GEMINI_API_KEY = import.meta.env.VITE_GEMINI_API_KEY
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`

interface GolferInfo {
  name: string
  country: string
  power_ranking: number | null
  scoring_avg: number | null
  bio: string | null
  masters_record: string | null
}

export async function getPickRecommendation(
  availableGolfers: GolferInfo[],
  myPicks: string[],
  roundNumber: number,
  totalRounds: number,
): Promise<string> {
  if (!GEMINI_API_KEY) return 'AI unavailable — no API key configured'

  const top20 = availableGolfers
    .sort((a, b) => (a.power_ranking ?? 999) - (b.power_ranking ?? 999))
    .slice(0, 20)

  const golferList = top20.map(g => {
    const parts = [`${g.name} (#${g.power_ranking ?? '?'})`]
    if (g.scoring_avg) parts.push(`Augusta avg: ${g.scoring_avg}`)
    if (g.masters_record) {
      const starts = g.masters_record.split('-').length
      const wins = (g.masters_record.match(/\b1\b/g) || []).length
      parts.push(`${starts} Masters starts${wins ? `, ${wins} win${wins > 1 ? 's' : ''}` : ''}`)
    } else {
      parts.push('Masters rookie')
    }
    return parts.join(' | ')
  }).join('\n')

  const prompt = `You are a Masters Tournament fantasy golf expert helping with a draft pick. Be fun and conversational — this is a family fantasy draft.

CONTEXT:
- Round ${roundNumber} of ${totalRounds} in a snake draft
- My current picks: ${myPicks.length > 0 ? myPicks.join(', ') : 'None yet'}
- Scoring: Best 2 of 4 golfers count. Lowest combined to-par wins. Need at least 2 golfers to make the cut.

AVAILABLE GOLFERS (top 20 by power ranking):
${golferList}

Give me your TOP 3 recommendations for this pick. For each:
1. Name and why they're a good pick
2. One bold stat or fun fact

Keep it under 150 words total. Be decisive — tell me who to pick. End with a one-liner hot take.`

  try {
    const response = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.9,
          maxOutputTokens: 300,
        },
      }),
    })

    if (!response.ok) throw new Error('Gemini API error')

    const data = await response.json()
    return data.candidates?.[0]?.content?.parts?.[0]?.text || 'AI assistant is thinking...'
  } catch (e) {
    console.error('Gemini error:', e)
    return 'AI draft assistant unavailable — trust your gut!'
  }
}

export async function getTrashTalk(
  playerName: string,
  golferPicked: string,
  context: string,
): Promise<string> {
  if (!GEMINI_API_KEY) return ''

  const prompt = `Generate a single fun, family-friendly trash talk message for a fantasy golf draft group chat. ${playerName} just picked ${golferPicked}. Context: ${context}. Keep it under 30 words. Be playful and golf-themed. No hashtags.`

  try {
    const response = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 1.0, maxOutputTokens: 60 },
      }),
    })

    if (!response.ok) return ''
    const data = await response.json()
    return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || ''
  } catch (e) {
    console.error('Gemini error:', e)
    return ''
  }
}

export async function getTournamentSummary(
  playerStandings: { name: string; score: number; golfers: string[] }[],
  round: number,
): Promise<string> {
  if (!GEMINI_API_KEY) return 'AI unavailable — no API key configured'

  const standingsText = playerStandings.map((p, i) =>
    `${i + 1}. ${p.name} (${p.score === 0 ? 'E' : p.score > 0 ? '+' + p.score : p.score}): ${p.golfers.join(', ')}`
  ).join('\n')

  const prompt = `You're a fun Masters Tournament commentator for a family fantasy golf pool called "The Morrison Open". Give a 2-3 sentence exciting update.

Current standings (best 2 of 4 golfers, lowest wins):
${standingsText}

Round: ${round} of 4

Be playful, mention specific players by name, add golf commentary. Keep it under 60 words.`

  try {
    const response = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.9, maxOutputTokens: 150 },
      }),
    })

    if (!response.ok) throw new Error('Gemini API error')
    const data = await response.json()
    return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || 'No commentary available right now.'
  } catch (e) {
    console.error('Gemini error:', e)
    return 'AI commentary unavailable — enjoy the tournament!'
  }
}

export async function getLeaderboardInsight(
  standings: { name: string; score: number; eliminated: boolean }[],
): Promise<string> {
  if (!GEMINI_API_KEY) return 'AI unavailable — no API key configured'

  const standingsText = standings.map((s, i) =>
    `${i + 1}. ${s.name} ${s.score === 0 ? 'E' : s.score > 0 ? '+' + s.score : s.score}${s.eliminated ? ' (ELIMINATED)' : ''}`
  ).join(', ')

  const prompt = `Quick 1-2 sentence fantasy golf analysis. Standings: ${standingsText}. Who's in trouble? Who's looking good? Be fun and brief.`

  try {
    const response = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.9, maxOutputTokens: 100 },
      }),
    })

    if (!response.ok) throw new Error('Gemini API error')
    const data = await response.json()
    return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || 'No insight available.'
  } catch (e) {
    console.error('Gemini error:', e)
    return 'AI analysis unavailable right now.'
  }
}

export async function getChatResponse(
  question: string,
  context: string,
): Promise<string> {
  if (!GEMINI_API_KEY) return 'AI unavailable — no API key configured'

  const prompt = `You're the AI assistant for "The Morrison Open" family fantasy golf draft. Someone asked: "${question}". Context: ${context}. Give a fun, brief answer (under 40 words). Be golf-themed and playful.`

  try {
    const response = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.9, maxOutputTokens: 80 },
      }),
    })

    if (!response.ok) throw new Error('Gemini API error')
    const data = await response.json()
    return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "Hmm, I'm stumped. Even Augusta's azaleas don't have an answer for that one!"
  } catch (e) {
    console.error('Gemini error:', e)
    return "AI caddie is taking a break — try again later!"
  }
}

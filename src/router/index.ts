import { createRouter, createWebHistory } from 'vue-router'

const routes = [
  {
    path: '/login',
    name: 'Login',
    component: () => import('@/views/LoginView.vue'),
    meta: { requiresAuth: false },
  },
  {
    path: '/register',
    name: 'Register',
    component: () => import('@/views/RegisterView.vue'),
    meta: { requiresAuth: false },
  },
  {
    path: '/',
    redirect: '/dashboard',
  },
  {
    path: '/dashboard',
    name: 'Dashboard',
    component: () => import('@/views/DashboardView.vue'),
  },
  {
    path: '/draft',
    name: 'Draft',
    component: () => import('@/views/DraftView.vue'),
  },
  {
    path: '/leaderboard',
    name: 'Leaderboard',
    component: () => import('@/views/LeaderboardView.vue'),
  },
  {
    path: '/my-team',
    name: 'MyTeam',
    component: () => import('@/views/MyTeamView.vue'),
  },
  {
    path: '/chat',
    name: 'Chat',
    component: () => import('@/views/ChatView.vue'),
  },
  {
    path: '/golfers',
    name: 'Golfers',
    component: () => import('@/views/GolfersView.vue'),
  },
  {
    path: '/matchup',
    name: 'Matchup',
    component: () => import('@/views/MatchupView.vue'),
  },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

router.beforeEach((to, _from, next) => {
  const requiresAuth = to.meta.requiresAuth !== false
  const token = localStorage.getItem('sb-auth-token')

  if (requiresAuth && !token) {
    next('/login')
  } else if (!requiresAuth && token && (to.name === 'Login' || to.name === 'Register')) {
    next('/dashboard')
  } else {
    next()
  }
})

export default router

import { useCallback, useState } from 'react'
import { communityCategoryLabel } from '@shared/libraryStates.mjs'
import { usePortalSession } from '@shared/ui/usePortalSession'
import { useAsync } from '@shared/ui/useAsync'
import { AppShell, ErrorAlert } from '../components/ui'
import { CategoryGrid, SearchBar, PostList, NewPostForm, PostDetail } from '../components/community'
import StudentAuth from './StudentAuth'

// The hash router (@shared/ui/router) only hands us the raw path, so
// Community does its own light-weight sub-routing off the remainder:
//   /community        -> list
//   /community/new     -> new post form
//   /community/<id>    -> post detail
function parseRoute(route) {
  const rest = route.replace(/^\/community\/?/, '')
  if (!rest) return { view: 'list' }
  if (rest === 'new') return { view: 'new' }
  return { view: 'detail', postId: rest }
}

export default function CommunityPortal({ route }) {
  const portal = usePortalSession('student')
  const user = portal.user
  return (
    <AppShell
      section="Community"
      right={
        user ? (
          <>
            <a className="btn btn-ghost btn-sm" href="#/student">
              My visit
            </a>
            <span className="muted">{user.name}</span>
            <button className="btn btn-outline btn-sm" onClick={portal.logout}>
              Sign out
            </button>
          </>
        ) : (
          <a className="btn btn-ghost btn-sm" href="#/">
            Back
          </a>
        )
      }
    >
      {user ? (
        <CommunityHome api={portal.api} user={user} route={route} />
      ) : (
        <StudentAuth api={portal.api} onSignedIn={portal.save} />
      )}
    </AppShell>
  )
}

function CommunityHome({ api, user, route }) {
  const { view, postId } = parseRoute(route)
  if (view === 'new') return <NewPostPage api={api} />
  if (view === 'detail') return <PostDetailPage api={api} user={user} postId={postId} />
  return <CommunityListPage api={api} />
}

function NewPostPage({ api }) {
  return (
    <div className="page">
      <a className="link-btn" href="#/community">
        ← Back to Community
      </a>
      <div className="page-head">
        <div>
          <h1>New post</h1>
          <p>Ask for help, offer something, or find people to work with.</p>
        </div>
      </div>
      <NewPostForm
        api={api}
        onSaved={(post) => {
          window.location.hash = `/community/${post.id}`
        }}
        onCancel={() => {
          window.location.hash = '/community'
        }}
      />
    </div>
  )
}

function CommunityListPage({ api }) {
  const [category, setCategory] = useState(null)
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [mine, setMine] = useState(false)

  const fetchPosts = useCallback(
    () =>
      api.get('/api/community/posts', {
        category: category || undefined,
        q: search || undefined,
        mine: mine || undefined,
        limit: 30
      }),
    [api, category, search, mine]
  )
  const { data, error } = useAsync(api ? fetchPosts : null)

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>IIT Delhi Student Network</h1>
          <p>Find resources, people and opportunities across the institute.</p>
        </div>
        <a className="btn" href="#/community/new">
          Create a request
        </a>
      </div>
      <SearchBar value={query} onChange={setQuery} onSubmit={() => setSearch(query.trim())} />
      <CategoryGrid active={category} onSelect={setCategory} />
      <div className="panel-head">
        <h2>
          {search
            ? `Results for "${search}"`
            : category
              ? communityCategoryLabel(category)
              : 'Recent requests'}
        </h2>
        <label className="community-mine-toggle">
          <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} />
          My posts
        </label>
      </div>
      <ErrorAlert error={error} />
      <PostList posts={data?.items} />
    </div>
  )
}

function PostDetailPage({ api, user, postId }) {
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)

  const fetchPost = useCallback(() => api.get(`/api/community/posts/${postId}`), [api, postId])
  const { data: post, error, setData: setPost } = useAsync(api ? fetchPost : null)

  const fetchComments = useCallback(
    () => api.get(`/api/community/posts/${postId}/comments`, { limit: 100 }),
    [api, postId]
  )
  const { data: commentPage, setData: setCommentPage } = useAsync(api && post ? fetchComments : null)

  async function withBusy(fn) {
    if (busy) return
    setBusy(true)
    try {
      await fn()
    } finally {
      setBusy(false)
    }
  }

  if (error) {
    return (
      <div className="page">
        <ErrorAlert error={error} />
      </div>
    )
  }
  if (!post) return <div className="page muted">Loading…</div>

  // This portal is student-only (staff moderate from the staff console's
  // Community tab instead), so ownership is the only permission that matters here.
  const isOwner = post.author?.entryNumber === user.entryNumber

  return (
    <PostDetail
      post={post}
      comments={commentPage?.items}
      isOwner={isOwner}
      isStaff={false}
      busy={busy}
      api={api}
      onInterestToggle={() =>
        withBusy(async () => {
          const r = await api.post(`/api/community/posts/${postId}/interest`)
          setPost(r.post)
        })
      }
      onToggleResolved={() =>
        withBusy(async () => {
          const next = post.status === 'resolved' ? 'open' : 'resolved'
          setPost(await api.patch(`/api/community/posts/${postId}`, { status: next }))
        })
      }
      onDelete={() =>
        withBusy(async () => {
          if (!window.confirm('Delete this post? This cannot be undone.')) return
          await api.delete(`/api/community/posts/${postId}`)
          window.location.hash = '/community'
        })
      }
      editing={editing}
      onStartEdit={() => setEditing(true)}
      onCancelEdit={() => setEditing(false)}
      onSavedEdit={(saved) => {
        setPost(saved)
        setEditing(false)
      }}
      onAddComment={async (body) => {
        const comment = await api.post(`/api/community/posts/${postId}/comments`, { body })
        setCommentPage((p) => ({
          ...p,
          items: [...(p?.items || []), comment],
          total: (p?.total || 0) + 1
        }))
        setPost((p) => ({ ...p, commentCount: p.commentCount + 1 }))
      }}
    />
  )
}

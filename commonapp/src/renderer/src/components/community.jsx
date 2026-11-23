// Presentational building blocks for the Community board (see CommunityPortal.jsx).
import { useState } from 'react'
import { COMMUNITY_CATEGORIES, communityCategoryLabel } from '@shared/libraryStates.mjs'
import { formatDateTime } from '@shared/ui/time'
import { ErrorAlert } from './ui'

export function CategoryGrid({ active, onSelect }) {
  return (
    <div className="category-grid">
      {COMMUNITY_CATEGORIES.map((c) => (
        <button
          key={c.key}
          type="button"
          className={`category-card${active === c.key ? ' is-on' : ''}`}
          onClick={() => onSelect(active === c.key ? null : c.key)}
        >
          <strong>{c.label}</strong>
          <span>{c.blurb}</span>
        </button>
      ))}
    </div>
  )
}

export function SearchBar({ value, onChange, onSubmit }) {
  return (
    <form
      className="community-search"
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit()
      }}
    >
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search anything in IIT Delhi…"
        aria-label="Search community posts"
      />
      <button className="btn btn-sm" type="submit">
        Search
      </button>
    </form>
  )
}

export function PostCard({ post }) {
  return (
    <a className="post-card" href={`#/community/${post.id}`}>
      <div className="post-card-head">
        <span className="post-card-category">{communityCategoryLabel(post.category)}</span>
        {post.status === 'resolved' && <span className="badge badge-muted">Resolved</span>}
      </div>
      <strong className="post-card-title">{post.title}</strong>
      <p className="post-card-snippet">{post.body}</p>
      <div className="post-card-meta">
        <span>{post.author?.name || 'A student'}</span>
        <span>
          {post.interestedCount} interested · {post.commentCount} comment
          {post.commentCount === 1 ? '' : 's'}
        </span>
      </div>
    </a>
  )
}

export function PostList({ posts }) {
  if (!posts) return <p className="muted">Loading…</p>
  if (posts.length === 0)
    return <p className="muted">No requests here yet — be the first to post.</p>
  return (
    <div className="post-list">
      {posts.map((p) => (
        <PostCard key={p.id} post={p} />
      ))}
    </div>
  )
}

export function NewPostForm({ api, initial, onSaved, onCancel, submitLabel = 'Post' }) {
  const [category, setCategory] = useState(initial?.category || COMMUNITY_CATEGORIES[0].key)
  const [title, setTitle] = useState(initial?.title || '')
  const [body, setBody] = useState(initial?.body || '')
  const [tags, setTags] = useState((initial?.tags || []).join(', '))
  const [contactInfo, setContactInfo] = useState(initial?.contactInfo || '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function submit(e) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    const payload = {
      category,
      title: title.trim(),
      body: body.trim(),
      tags: tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
      contactInfo: contactInfo.trim()
    }
    try {
      const saved = initial
        ? await api.patch(`/api/community/posts/${initial.id}`, payload)
        : await api.post('/api/community/posts', payload)
      onSaved(saved)
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="panel form" onSubmit={submit}>
      <label className="field">
        Category
        <select value={category} onChange={(e) => setCategory(e.target.value)}>
          {COMMUNITY_CATEGORIES.map((c) => (
            <option key={c.key} value={c.key}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        Title
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          minLength={3}
          maxLength={140}
          required
        />
      </label>
      <label className="field">
        Details
        <textarea
          className="community-textarea"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={5}
          maxLength={4000}
          required
        />
      </label>
      <label className="field">
        Tags <span className="field-hint">Comma-separated, optional.</span>
        <input
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          placeholder="pytorch, ml, project"
        />
      </label>
      <label className="field">
        Contact info{' '}
        <span className="field-hint">
          Optional — only share what you&apos;re comfortable making public.
        </span>
        <input
          value={contactInfo}
          onChange={(e) => setContactInfo(e.target.value)}
          placeholder="Email, room number, phone…"
          maxLength={200}
        />
      </label>
      <ErrorAlert error={error} />
      <div className="row-actions">
        <button className="btn" type="submit" disabled={busy}>
          {busy ? 'Saving…' : submitLabel}
        </button>
        {onCancel && (
          <button className="btn btn-outline" type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        )}
      </div>
    </form>
  )
}

export function PostDetail({
  post,
  comments,
  isOwner,
  isStaff,
  onInterestToggle,
  onToggleResolved,
  onDelete,
  editing,
  onStartEdit,
  onCancelEdit,
  onSavedEdit,
  api,
  onAddComment,
  busy
}) {
  const [commentBody, setCommentBody] = useState('')
  const [commentBusy, setCommentBusy] = useState(false)
  const [commentError, setCommentError] = useState(null)

  async function submitComment(e) {
    e.preventDefault()
    if (!commentBody.trim() || commentBusy) return
    setCommentBusy(true)
    setCommentError(null)
    try {
      await onAddComment(commentBody.trim())
      setCommentBody('')
    } catch (err) {
      setCommentError(err)
    } finally {
      setCommentBusy(false)
    }
  }

  if (editing) {
    return (
      <NewPostForm
        api={api}
        initial={post}
        submitLabel="Save changes"
        onSaved={onSavedEdit}
        onCancel={onCancelEdit}
      />
    )
  }

  return (
    <div className="page">
      <a className="link-btn" href="#/community">
        ← Back to Community
      </a>
      <section className="panel post-detail">
        <div className="post-card-head">
          <span className="post-card-category">{communityCategoryLabel(post.category)}</span>
          {post.status === 'resolved' && <span className="badge badge-muted">Resolved</span>}
        </div>
        <h1 style={{ fontSize: 22 }}>{post.title}</h1>
        <p className="muted" style={{ fontSize: 13 }}>
          {post.author?.name || 'A student'} · {formatDateTime(post.createdAt)}
        </p>
        <p className="post-detail-body">{post.body}</p>
        {post.tags?.length > 0 && (
          <div className="tag-row">
            {post.tags.map((t) => (
              <span key={t} className="tag">
                #{t}
              </span>
            ))}
          </div>
        )}
        {post.contactInfo && (
          <p className="post-contact">
            <strong>Contact:</strong> {post.contactInfo}
          </p>
        )}
        <div className="row-actions" style={{ marginTop: 16 }}>
          {!isOwner && (
            <button
              className={`btn${post.youAreInterested ? '' : ' btn-outline'}`}
              onClick={onInterestToggle}
              disabled={busy}
            >
              {post.youAreInterested ? "I'm interested ✓" : "I'm interested"} ({post.interestedCount})
            </button>
          )}
          {(isOwner || isStaff) && (
            <>
              {isOwner && (
                <button className="btn btn-outline" onClick={onStartEdit} disabled={busy}>
                  Edit
                </button>
              )}
              {isOwner && (
                <button className="btn btn-outline" onClick={onToggleResolved} disabled={busy}>
                  {post.status === 'resolved' ? 'Reopen' : 'Mark resolved'}
                </button>
              )}
              <button className="btn btn-outline" onClick={onDelete} disabled={busy}>
                Delete
              </button>
            </>
          )}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>
            Comments {comments ? `(${comments.length})` : ''}
          </h2>
        </div>
        <form className="comment-form" onSubmit={submitComment}>
          <textarea
            className="community-textarea"
            rows={2}
            placeholder="Reply with an offer, a question, or more detail…"
            value={commentBody}
            onChange={(e) => setCommentBody(e.target.value)}
            maxLength={2000}
          />
          <button className="btn btn-sm" type="submit" disabled={commentBusy || !commentBody.trim()}>
            {commentBusy ? 'Posting…' : 'Reply'}
          </button>
        </form>
        <ErrorAlert error={commentError} />
        <div className="comment-list">
          {!comments && <p className="muted">Loading…</p>}
          {comments?.length === 0 && <p className="muted">No replies yet.</p>}
          {comments?.map((c) => (
            <div key={c.id} className="comment">
              <div className="comment-head">
                <strong>{c.author?.name || 'A student'}</strong>
                <span className="muted">{formatDateTime(c.createdAt)}</span>
              </div>
              <p>{c.body}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}

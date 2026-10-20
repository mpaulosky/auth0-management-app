// ============================================
// Copyright (c) 2026. All rights reserved.
// File Name :     CachedManagementApi.cs
// Company :       mpaulosky
// Author :        Teqslamer
// Solution Name : Auth0ManagementApp
// Project Name :  UI
// =============================================

using System.Diagnostics.CodeAnalysis;

using Domain.Abstractions;

using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Primitives;

namespace UI.ManagementApi;

/// <summary>
///   Caches the successful reads of the <see cref="IManagementApi" /> it wraps, so repeated reads don't spend Auth0's
///   rate limit, and drops the entries each write makes stale, whatever the write's outcome, since a write that failed
///   or threw may still have reached Auth0. It holds Tenant data, the same for every Admin, so it's
///   safe as a singleton.
/// </summary>
[SuppressMessage("Performance", "CA1812:Avoid uninstantiated internal classes",
	Justification = "AddManagementApi() registers it, and the container instantiates it.")]
internal sealed class CachedManagementApi : IManagementApi, IDisposable
{
	// The most entries the cache holds; each entry has size 1.
	private const int SizeLimit = 1000;

	private static readonly TimeSpan SearchLifetime = TimeSpan.FromSeconds(30);
	private static readonly TimeSpan UserLifetime = TimeSpan.FromSeconds(60);
	private static readonly TimeSpan RolesLifetime = TimeSpan.FromMinutes(5);
	private static readonly TimeSpan MembersLifetime = TimeSpan.FromSeconds(60);

	// How long no read is cached after a write threw. The write may still reach Auth0 after the exception, such as when
	// the caller's token fired or the HttpClient timed out once the request was sent, so a read in that gap could cache
	// the state from before it.
	private static readonly TimeSpan UncertainWriteWindow = TimeSpan.FromSeconds(10);
	private static readonly object RolesKey = new();

	private readonly MemoryCache _cache = new(new MemoryCacheOptions { SizeLimit = SizeLimit });
	private readonly IManagementApi _inner;
	private readonly TimeProvider _timeProvider;
	private readonly EvictionGroup _searchPages = new();
	private readonly EvictionGroup _roleMembers = new();
	private readonly Lock _writeLock = new();

	// Counts the writes that have evicted entries. A read compares it before and after calling Auth0.
	private long _evictions;

	// While the clock is before this, reads aren't cached: a write threw and may still land at Auth0.
	private DateTimeOffset _uncacheableUntil;

	/// <summary>
	///   Initializes a new instance of the <see cref="CachedManagementApi" /> class.
	/// </summary>
	/// <param name="inner">The adapter that calls Auth0.</param>
	/// <param name="timeProvider">The clock each entry's lifetime is measured against.</param>
	public CachedManagementApi(IManagementApi inner, TimeProvider timeProvider)
	{
		ArgumentNullException.ThrowIfNull(inner);
		ArgumentNullException.ThrowIfNull(timeProvider);

		_inner = inner;
		_timeProvider = timeProvider;
	}

	/// <inheritdoc />
	public Task<Result<UserPage>> SearchUsersAsync(UserSearch search, CancellationToken cancellationToken)
	{
		ArgumentNullException.ThrowIfNull(search);

		// The key keeps the query's case: the request goes to Auth0 as given, and Lucene's operators (OR, AND, NOT) and
		// some values are case-sensitive, so two queries that differ in case can return different Users. The Users slice
		// lower-cases the term it searches for before it builds the query, so its pages still share an entry.
		SearchKey key = new(search.Query?.Trim(), search.Page, search.PerPage);

		return ReadThroughAsync(key, SearchLifetime, _searchPages,
			() => _inner.SearchUsersAsync(search, cancellationToken));
	}

	/// <inheritdoc />
	public Task<Result<UserDetails>> GetUserAsync(string userId, CancellationToken cancellationToken)
	{
		return ReadThroughAsync(new UserKey(userId), UserLifetime, null,
			() => _inner.GetUserAsync(userId, cancellationToken));
	}

	/// <inheritdoc />
	public async Task<Result> UpdateProfileFieldsAsync(string userId, ProfileFieldsChange change,
		CancellationToken cancellationToken)
	{
		// Search pages and Role members carry the User's name, email and picture in their UserSummary rows.
		return await WriteAsync(() => _inner.UpdateProfileFieldsAsync(userId, change, cancellationToken), () =>
		{
			_cache.Remove(new UserKey(userId));
			_searchPages.EvictAll();
			_roleMembers.EvictAll();
		}).ConfigureAwait(false);
	}

	/// <inheritdoc />
	public async Task<Result> AssignRoleAsync(string userId, string roleId, CancellationToken cancellationToken)
	{
		return await WriteAsync(() => _inner.AssignRoleAsync(userId, roleId, cancellationToken),
			() => EvictRoleChange(userId, roleId)).ConfigureAwait(false);
	}

	/// <inheritdoc />
	public async Task<Result> RemoveRoleAsync(string userId, string roleId, CancellationToken cancellationToken)
	{
		return await WriteAsync(() => _inner.RemoveRoleAsync(userId, roleId, cancellationToken),
			() => EvictRoleChange(userId, roleId)).ConfigureAwait(false);
	}

	/// <inheritdoc />
	public Task<Result<IReadOnlyList<RoleSummary>>> ListRolesAsync(CancellationToken cancellationToken)
	{
		return ReadThroughAsync(RolesKey, RolesLifetime, null, () => _inner.ListRolesAsync(cancellationToken));
	}

	/// <inheritdoc />
	public async Task<Result<RoleSummary>> CreateRoleAsync(NewRole role, CancellationToken cancellationToken)
	{
		return await WriteAsync(() => _inner.CreateRoleAsync(role, cancellationToken),
			() => _cache.Remove(RolesKey)).ConfigureAwait(false);
	}

	/// <inheritdoc />
	public Task<Result<RoleMembers>> ListRoleMembersAsync(string roleId, CancellationToken cancellationToken)
	{
		return ReadThroughAsync(new MembersKey(roleId), MembersLifetime, _roleMembers,
			() => _inner.ListRoleMembersAsync(roleId, cancellationToken));
	}

	/// <inheritdoc />
	public Task<Result<int>> CountRoleMembersAsync(string roleId, int atMost, CancellationToken cancellationToken)
	{
		return _inner.CountRoleMembersAsync(roleId, atMost, cancellationToken);
	}

	/// <inheritdoc />
	public Task<Result<bool>> UserHoldsRoleAsync(string userId, string roleId, CancellationToken cancellationToken)
	{
		return _inner.UserHoldsRoleAsync(userId, roleId, cancellationToken);
	}

	/// <inheritdoc />
	public void Dispose()
	{
		_cache.Dispose();
		_searchPages.Dispose();
		_roleMembers.Dispose();
	}

	private async Task<Result<T>> ReadThroughAsync<T>(object key, TimeSpan lifetime, EvictionGroup? group,
		Func<Task<Result<T>>> read)
	{
		DateTimeOffset now = _timeProvider.GetUtcNow();

		if (_cache.TryGetValue(key, out Entry<T>? cached) && cached is not null && now < cached.ExpiresAt)
		{
			return cached.Result;
		}

		// Taken before the read, so a write that evicts the group while the read is in flight leaves this entry already
		// expired rather than caching what the write made stale. Removing a single key can't do that, so the read also
		// remembers how many evictions had happened and doesn't cache its result if another one has run since.
		CancellationChangeToken? evictionToken = group?.CurrentToken();
		long evictionsBefore;

		lock (_writeLock)
		{
			evictionsBefore = _evictions;
		}

		Result<T> result = await read().ConfigureAwait(false);

		// A failure, a 429 included, is never cached, so the next call asks Auth0 again.
		if (result.Failure)
		{
			return result;
		}

		// The MemoryCache keeps its own wall clock, which a FakeTimeProvider can't drive: the stored ExpiresAt decides
		// whether an entry is fresh, and the matching AbsoluteExpirationRelativeToNow only frees the memory.
		MemoryCacheEntryOptions options = new()
		{
			Size = 1,
			AbsoluteExpirationRelativeToNow = lifetime,
		};

		if (evictionToken is not null)
		{
			options.AddExpirationToken(evictionToken);
		}

		// Checked and stored under the lock the evictions run under, so no write can evict between the two.
		lock (_writeLock)
		{
			if (_evictions == evictionsBefore && _timeProvider.GetUtcNow() >= _uncacheableUntil)
			{
				_cache.Set(key, new Entry<T>(result, now + lifetime), options);
			}
		}

		return result;
	}

	private void EvictRoleChange(string userId, string roleId)
	{
		_cache.Remove(new UserKey(userId));
		_cache.Remove(new MembersKey(roleId));
	}

	// Runs the write, then evicts whatever its outcome. When the write threw, it also stops reads from being cached for
	// a while, because the eviction can't cover a write that lands at Auth0 afterwards.
	private async Task<T> WriteAsync<T>(Func<Task<T>> write, Action evict)
	{
		bool threw = false;

		try
		{
			return await write().ConfigureAwait(false);
		}
		catch (Exception)
		{
			threw = true;

			throw;
		}
		finally
		{
			lock (_writeLock)
			{
				_evictions++;
				evict();

				if (threw)
				{
					_uncacheableUntil = _timeProvider.GetUtcNow() + UncertainWriteWindow;
				}
			}
		}
	}

	private sealed record Entry<T>(Result<T> Result, DateTimeOffset ExpiresAt);

	private sealed record SearchKey(string? Query, int Page, int PerPage);

	private sealed record UserKey(string UserId);

	private sealed record MembersKey(string RoleId);

	/// <summary>
	///   A set of entries a write drops together, such as every search page: each entry carries the group's current
	///   token, and <see cref="EvictAll" /> cancels it and starts a new one.
	/// </summary>
	private sealed class EvictionGroup : IDisposable
	{
		private readonly Lock _lock = new();
		private CancellationTokenSource _source = new();

		public CancellationChangeToken CurrentToken()
		{
			lock (_lock)
			{
				return new CancellationChangeToken(_source.Token);
			}
		}

		public void EvictAll()
		{
			CancellationTokenSource evicted;

			lock (_lock)
			{
				evicted = _source;
				_source = new CancellationTokenSource();
			}

			// Readers take the token under the lock, so none can reach the evicted source once it's swapped out.
			evicted.Cancel();
			evicted.Dispose();
		}

		public void Dispose()
		{
			_source.Dispose();
		}
	}
}

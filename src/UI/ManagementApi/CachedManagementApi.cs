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
	private static readonly object RolesKey = new();

	private readonly MemoryCache _cache = new(new MemoryCacheOptions { SizeLimit = SizeLimit });
	private readonly IManagementApi _inner;
	private readonly TimeProvider _timeProvider;
	private readonly EvictionGroup _searchPages = new();
	private readonly EvictionGroup _roleMembers = new();

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
	[SuppressMessage("Globalization", "CA1308:Normalize strings to uppercase",
		Justification = "The key follows the plan's normalization, the lower-case form the Users slice searches with.")]
	public Task<Result<UserPage>> SearchUsersAsync(UserSearch search, CancellationToken cancellationToken)
	{
		ArgumentNullException.ThrowIfNull(search);

		SearchKey key = new(search.Query?.Trim().ToLowerInvariant(), search.Page, search.PerPage);

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
		try
		{
			return await _inner.UpdateProfileFieldsAsync(userId, change, cancellationToken).ConfigureAwait(false);
		}
		finally
		{
			// Search pages and Role members carry the User's name, email and picture in their UserSummary rows.
			_cache.Remove(new UserKey(userId));
			_searchPages.EvictAll();
			_roleMembers.EvictAll();
		}
	}

	/// <inheritdoc />
	public async Task<Result> AssignRoleAsync(string userId, string roleId, CancellationToken cancellationToken)
	{
		try
		{
			return await _inner.AssignRoleAsync(userId, roleId, cancellationToken).ConfigureAwait(false);
		}
		finally
		{
			EvictRoleChange(userId, roleId);
		}
	}

	/// <inheritdoc />
	public async Task<Result> RemoveRoleAsync(string userId, string roleId, CancellationToken cancellationToken)
	{
		try
		{
			return await _inner.RemoveRoleAsync(userId, roleId, cancellationToken).ConfigureAwait(false);
		}
		finally
		{
			EvictRoleChange(userId, roleId);
		}
	}

	/// <inheritdoc />
	public Task<Result<IReadOnlyList<RoleSummary>>> ListRolesAsync(CancellationToken cancellationToken)
	{
		return ReadThroughAsync(RolesKey, RolesLifetime, null, () => _inner.ListRolesAsync(cancellationToken));
	}

	/// <inheritdoc />
	public async Task<Result<RoleSummary>> CreateRoleAsync(NewRole role, CancellationToken cancellationToken)
	{
		try
		{
			return await _inner.CreateRoleAsync(role, cancellationToken).ConfigureAwait(false);
		}
		finally
		{
			_cache.Remove(RolesKey);
		}
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
		// expired rather than caching what the write made stale.
		CancellationChangeToken? evictionToken = group?.CurrentToken();
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

		_cache.Set(key, new Entry<T>(result, now + lifetime), options);

		return result;
	}

	private void EvictRoleChange(string userId, string roleId)
	{
		_cache.Remove(new UserKey(userId));
		_cache.Remove(new MembersKey(roleId));
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

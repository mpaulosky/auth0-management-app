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
	/// <summary>The most entries the cache holds; each entry has size 1.</summary>
	public const int SizeLimit = 1000;

	private static readonly TimeSpan SearchLifetime = TimeSpan.FromSeconds(30);
	private static readonly TimeSpan UserLifetime = TimeSpan.FromSeconds(60);
	private static readonly TimeSpan RolesLifetime = TimeSpan.FromMinutes(5);
	private static readonly TimeSpan MembersLifetime = TimeSpan.FromSeconds(60);
	private static readonly object RolesKey = new();

	private readonly MemoryCache _cache = new(new MemoryCacheOptions { SizeLimit = SizeLimit });
	private readonly IManagementApi _inner;
	private readonly Lock _evictionLock = new();
	private readonly TimeProvider _timeProvider;
	private CancellationTokenSource _searchEviction = new();
	private CancellationTokenSource _membersEviction = new();

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

		return ReadThroughAsync(key, SearchLifetime, EvictionToken(ref _searchEviction),
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
			EvictAll(ref _searchEviction);
			EvictAll(ref _membersEviction);
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
		return ReadThroughAsync(new MembersKey(roleId), MembersLifetime, EvictionToken(ref _membersEviction),
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
		_searchEviction.Dispose();
		_membersEviction.Dispose();
	}

	private async Task<Result<T>> ReadThroughAsync<T>(object key, TimeSpan lifetime, CancellationToken? evictionToken,
		Func<Task<Result<T>>> read)
	{
		if (_cache.TryGetValue(key, out Entry<T>? cached) && cached is not null
			&& _timeProvider.GetUtcNow() < cached.ExpiresAt)
		{
			return cached.Result;
		}

		DateTimeOffset expiresAt = _timeProvider.GetUtcNow() + lifetime;
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

		// The token was taken before the read, so a write that evicted the set while the read was in flight leaves this
		// entry already expired rather than caching what the write made stale.
		if (evictionToken is { } token)
		{
			options.AddExpirationToken(new CancellationChangeToken(token));
		}

		_cache.Set(key, new Entry<T>(result, expiresAt), options);

		return result;
	}

	private void EvictRoleChange(string userId, string roleId)
	{
		_cache.Remove(new UserKey(userId));
		_cache.Remove(new MembersKey(roleId));
	}

	private CancellationToken EvictionToken(ref CancellationTokenSource source)
	{
		lock (_evictionLock)
		{
			return source.Token;
		}
	}

	private void EvictAll(ref CancellationTokenSource source)
	{
		CancellationTokenSource evicted;

		lock (_evictionLock)
		{
			evicted = source;
			source = new CancellationTokenSource();
		}

		// Readers take the token under the lock, so none can reach the evicted source once it's swapped out.
		evicted.Cancel();
		evicted.Dispose();
	}

	private sealed record Entry<T>(Result<T> Result, DateTimeOffset ExpiresAt);

	private sealed record SearchKey(string? Query, int Page, int PerPage);

	private sealed record UserKey(string UserId);

	private sealed record MembersKey(string RoleId);
}

// ============================================
// Copyright (c) 2026. All rights reserved.
// File Name :     RateLimitMark.cs
// Company :       mpaulosky
// Author :        Teqslamer
// Solution Name : Auth0ManagementApp
// Project Name :  UI
// =============================================

namespace UI.ManagementApi;

/// <summary>
///   Records, for one <see cref="IManagementApi" /> call, whether any of its requests met a 429, from Auth0 or from the
///   client-side limiter. The SDK's timeout covers both attempts, so it can cancel a call that was only rate limited;
///   the adapter reads this mark to report that as <c>ManagementApi.RateLimited</c> rather than as an outage.
/// </summary>
internal sealed class RateLimitMark : IDisposable
{
	private static readonly AsyncLocal<RateLimitMark?> CurrentMark = new();

	private readonly RateLimitMark? _previous;
	private int _metRateLimit;

	private RateLimitMark(RateLimitMark? previous)
	{
		_previous = previous;
	}

	/// <summary>
	///   Gets the mark of the call the current request belongs to, or <see langword="null" /> outside a call.
	/// </summary>
	public static RateLimitMark? Current => CurrentMark.Value;

	/// <summary>
	///   Gets a value indicating whether a request of this call met a 429.
	/// </summary>
	public bool MetRateLimit => Volatile.Read(ref _metRateLimit) == 1;

	/// <summary>
	///   Starts a mark for the call running on the current async flow. The HTTP requests the call sends flow from it, so
	///   the rate-limiting handler finds this mark through <see cref="Current" />.
	/// </summary>
	/// <returns>The mark, which restores the previous one when disposed.</returns>
	public static RateLimitMark Begin()
	{
		RateLimitMark mark = new(CurrentMark.Value);
		CurrentMark.Value = mark;

		return mark;
	}

	/// <summary>
	///   Records that a request of this call met a 429.
	/// </summary>
	public void Mark()
	{
		Volatile.Write(ref _metRateLimit, 1);
	}

	/// <inheritdoc />
	public void Dispose()
	{
		CurrentMark.Value = _previous;
	}
}

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
///   Records, for one <see cref="IManagementApi" /> call, whether the request now in flight, or an earlier one that
///   hasn't since succeeded, met a 429, and whose it was: Auth0's, or the client-side limiter's own refusal, which never
///   reached Auth0. A success clears both, so a later page's outage isn't taken for rate limiting. The SDK's timeout
///   covers both attempts, so it can cancel a call that was only rate limited; the adapter reads this mark to report
///   that as <c>ManagementApi.RateLimited</c> rather than as an outage. A 5xx is read as Auth0 shedding load only after
///   a 429 from Auth0 itself: a local refusal says nothing about Auth0's health.
/// </summary>
internal sealed class RateLimitMark : IDisposable
{
	private static readonly AsyncLocal<RateLimitMark?> CurrentMark = new();

	private readonly RateLimitMark? _previous;
	private int _metAuth0RateLimit;
	private int _metLocalRefusal;

	private RateLimitMark(RateLimitMark? previous)
	{
		_previous = previous;
	}

	/// <summary>
	///   Gets the mark of the call the current request belongs to, or <see langword="null" /> outside a call.
	/// </summary>
	public static RateLimitMark? Current => CurrentMark.Value;

	/// <summary>
	///   Gets a value indicating whether the current request, or a failed one before it, met a 429 from Auth0.
	/// </summary>
	public bool MetAuth0RateLimit => Volatile.Read(ref _metAuth0RateLimit) == 1;

	/// <summary>
	///   Gets a value indicating whether the current request, or a failed one before it, met a 429, from Auth0 or from
	///   the client-side limiter.
	/// </summary>
	public bool MetRateLimit => MetAuth0RateLimit || Volatile.Read(ref _metLocalRefusal) == 1;

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
	///   Records that a request of this call met a 429 from Auth0.
	/// </summary>
	public void MarkAuth0RateLimit()
	{
		Volatile.Write(ref _metAuth0RateLimit, 1);
	}

	/// <summary>
	///   Records that the client-side limiter refused a request of this call, which never reached Auth0.
	/// </summary>
	public void MarkLocalRefusal()
	{
		Volatile.Write(ref _metLocalRefusal, 1);
	}

	/// <summary>
	///   Records that a request succeeded, so a 429 an earlier request of this call met no longer explains a later failure.
	/// </summary>
	public void Clear()
	{
		Volatile.Write(ref _metAuth0RateLimit, 0);
		Volatile.Write(ref _metLocalRefusal, 0);
	}

	/// <inheritdoc />
	public void Dispose()
	{
		CurrentMark.Value = _previous;
	}
}

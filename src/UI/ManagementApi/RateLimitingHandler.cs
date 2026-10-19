// ============================================
// Copyright (c) 2026. All rights reserved.
// File Name :     RateLimitingHandler.cs
// Company :       mpaulosky
// Author :        Teqslamer
// Solution Name : Auth0ManagementApp
// Project Name :  UI
// =============================================

using System.Diagnostics.CodeAnalysis;
using System.Net;
using System.Text;
using System.Threading.RateLimiting;

using Microsoft.Extensions.Options;

namespace UI.ManagementApi;

/// <summary>
///   Takes one token from the client-side <see cref="RateLimiter" /> for each request to <c>/api/v2/*</c> on the
///   <c>"Auth0Management"</c> client, retries included, so the app stays under Auth0's own bucket. A request that waits
///   past <see cref="ManagementApiOptions.QueueTimeout" />, or finds the queue full, gets a 429 from this handler and
///   never reaches Auth0.
/// </summary>
[SuppressMessage("Performance", "CA1812:Avoid uninstantiated internal classes",
	Justification = "The HTTP client factory instantiates it for the Auth0Management client.")]
internal sealed class RateLimitingHandler : DelegatingHandler
{
	private const string ManagementApiPathPrefix = "/api/v2/";

	private const string OwnRateLimitBody =
		"""{"statusCode":429,"error":"Too Many Requests","message":"The app's client-side rate limiter refused the request."}""";

	private readonly RateLimiter _limiter;
	private readonly TimeSpan _queueTimeout;

	/// <summary>
	///   Initializes a new instance of the <see cref="RateLimitingHandler" /> class.
	/// </summary>
	/// <param name="limiter">The app's one token bucket for the Management API.</param>
	/// <param name="options">The Management API settings, read for the queue timeout.</param>
	public RateLimitingHandler(RateLimiter limiter, IOptions<ManagementApiOptions> options)
	{
		ArgumentNullException.ThrowIfNull(limiter);
		ArgumentNullException.ThrowIfNull(options);

		_limiter = limiter;
		_queueTimeout = options.Value.QueueTimeout;
	}

	/// <inheritdoc />
	protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,
		CancellationToken cancellationToken)
	{
		ArgumentNullException.ThrowIfNull(request);

		// /oauth/token is the Authentication API, with its own limits, and the token is cached, so it takes no token.
		if (request.RequestUri?.AbsolutePath.StartsWith(ManagementApiPathPrefix, StringComparison.Ordinal) != true)
		{
			return await base.SendAsync(request, cancellationToken).ConfigureAwait(false);
		}

		using RateLimitLease? lease = await AcquireAsync(cancellationToken).ConfigureAwait(false);

		if (lease is not { IsAcquired: true })
		{
			RateLimitMark.Current?.Mark();

			return OwnRateLimitResponse(request);
		}

		HttpResponseMessage response = await base.SendAsync(request, cancellationToken).ConfigureAwait(false);

		if (response.StatusCode == HttpStatusCode.TooManyRequests)
		{
			RateLimitMark.Current?.Mark();
		}
		else if (response.IsSuccessStatusCode)
		{
			// A request that gets through ends the rate limiting for the mark: a later request's failure is its own.
			RateLimitMark.Current?.Clear();
		}

		return response;
	}

	// Null when the request waited past the queue timeout. The queue timeout is real time, not the injected
	// TimeProvider: it bounds how long a request really waits inside the SDK's own real-time timeout.
	private async Task<RateLimitLease?> AcquireAsync(CancellationToken cancellationToken)
	{
		using CancellationTokenSource queueTimeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
		queueTimeout.CancelAfter(_queueTimeout);

		try
		{
			return await _limiter.AcquireAsync(1, queueTimeout.Token).ConfigureAwait(false);
		}
		catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
		{
			return null;
		}
	}

	// No X-RateLimit-* headers: the wait isn't Auth0's, so the message says "in a few seconds".
	private static HttpResponseMessage OwnRateLimitResponse(HttpRequestMessage request)
	{
		return new HttpResponseMessage(HttpStatusCode.TooManyRequests)
		{
			Content = new StringContent(OwnRateLimitBody, Encoding.UTF8, "application/json"),
			RequestMessage = request,
		};
	}
}

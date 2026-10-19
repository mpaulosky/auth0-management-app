// ============================================
// Copyright (c) 2026. All rights reserved.
// File Name :     RateLimiterTests.cs
// Company :       mpaulosky
// Author :        Teqslamer
// Solution Name : Auth0ManagementApp
// Project Name :  UI.Tests.Unit
// =============================================

using System.Threading.RateLimiting;

using Domain.Abstractions;

using UI.ManagementApi;

namespace UI.Tests.Unit.ManagementApi;

public class RateLimiterTests
{
	private const string FewSeconds = "Auth0 is rate limiting the app. Try again in a few seconds.";

	private static int Available(RateLimiter limiter) => (int)limiter.GetStatistics()!.CurrentAvailablePermits;

	private static int Queued(RateLimiter limiter) => (int)limiter.GetStatistics()!.CurrentQueuedCount;

	[Fact]
	public async Task Request_ToManagementApi_TakesOneTokenAndTheTokenExchangeTakesNone()
	{
		// Arrange
		using TokenBucketRateLimiter limiter = ManagementApiHarness.ManualLimiter(tokenLimit: 1);
		using ManagementApiHarness harness = ManagementApiHarness.Create(new HarnessOptions { Limiter = limiter });
		harness.Handler.Respond(_ => Auth0Responses.NoContent());

		// Act
		Result result = await harness.Api.AssignRoleAsync(ApiCalls.UserId, ApiCalls.RoleId, Xunit.TestContext.Current.CancellationToken);

		// Assert
		result.Success.Should().BeTrue("the bucket's only token went to /api/v2, not to /oauth/token, so nothing queued");
		harness.Handler.TokenRequestCount.Should().Be(1);
		harness.Handler.ManagementRequests.Should().HaveCount(1);
		Available(limiter).Should().Be(0);
	}

	[Fact]
	public async Task Request_RetriedAfter429_TakesATokenForTheRetryToo()
	{
		// Arrange
		using TokenBucketRateLimiter limiter = ManagementApiHarness.ManualLimiter(tokenLimit: 5);
		using ManagementApiHarness harness = ManagementApiHarness.Create(new HarnessOptions { Limiter = limiter });
		long resetSoon = DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 1;
		int attempts = 0;
		harness.Handler.Respond(_ => Interlocked.Increment(ref attempts) == 1
			? Auth0Responses.RateLimited(resetSoon)
			: Auth0Responses.NoContent());

		// Act
		Result result = await harness.Api.AssignRoleAsync(ApiCalls.UserId, ApiCalls.RoleId, Xunit.TestContext.Current.CancellationToken);

		// Assert
		result.Success.Should().BeTrue();
		harness.Handler.ManagementRequests.Should().HaveCount(2);
		Available(limiter).Should().Be(3, "the first attempt and its retry took a token each");
	}

	[Fact]
	public async Task ListRoleMembersAsync_MultiPageListing_WaitsForATokenBeforeEachPage()
	{
		// Arrange
		using TokenBucketRateLimiter limiter = ManagementApiHarness.ManualLimiter(tokenLimit: 1);
		using ManagementApiHarness harness = ManagementApiHarness.Create(new HarnessOptions { Limiter = limiter });
		harness.Handler.Respond(request =>
		{
			string? from = request.Query["from"];
			int index = from is null ? 0 : int.Parse(from[1..], System.Globalization.CultureInfo.InvariantCulture);

			return Auth0Responses.RoleUsersPage([$"auth0|page{index}"], index < 2 ? $"c{index + 1}" : null);
		});

		// Act
		Task<Result<RoleMembers>> call = harness.Api.ListRoleMembersAsync(ApiCalls.RoleId, Xunit.TestContext.Current.CancellationToken);
		await ManagementApiHarness.WaitUntilAsync(() => Queued(limiter) == 1, "the second page is waiting for a token");
		int requestsBeforeFirstRefill = harness.Handler.ManagementRequests.Count;
		limiter.TryReplenish();
		await ManagementApiHarness.WaitUntilAsync(() => Queued(limiter) == 1, "the third page is waiting for a token");
		int requestsBeforeSecondRefill = harness.Handler.ManagementRequests.Count;
		limiter.TryReplenish();
		Result<RoleMembers> result = await call;

		// Assert
		requestsBeforeFirstRefill.Should().Be(1);
		requestsBeforeSecondRefill.Should().Be(2);
		ApiCalls.ValueOf(result).Users.Select(user => user.Id).Should().Equal("auth0|page0", "auth0|page1", "auth0|page2");
		harness.Handler.ManagementRequests.Should().HaveCount(3);
	}

	[Fact]
	public async Task Request_WaitsPastQueueTimeout_GetsTheLimitersOwn429AndNeverReachesAuth0()
	{
		// Arrange
		using TokenBucketRateLimiter limiter = ManagementApiHarness.ManualLimiter(tokenLimit: 1);
		using RateLimitLease drained = limiter.AttemptAcquire();
		using ManagementApiHarness harness = ManagementApiHarness.Create(
			new HarnessOptions { Limiter = limiter, QueueTimeout = TimeSpan.FromSeconds(1) });
		harness.Handler.Respond(_ => Auth0Responses.NoContent());

		// Act
		Result result = await harness.Api.AssignRoleAsync(ApiCalls.UserId, ApiCalls.RoleId, Xunit.TestContext.Current.CancellationToken);

		// Assert
		result.Success.Should().BeFalse();
		result.ErrorCode.Should().Be(ResultErrorCode.RateLimited);
		result.Details.Should().Be("ManagementApi.RateLimited");
		result.Error.Should().Be(FewSeconds, "the limiter's own 429 has no X-RateLimit-Reset header");
		harness.Handler.ManagementRequests.Should().BeEmpty("a request that timed out in the queue never reaches Auth0");
	}

	[Fact]
	public async Task Request_QueueIsFull_GetsTheLimitersOwn429AtOnceAndNeverReachesAuth0()
	{
		// Arrange
		using TokenBucketRateLimiter limiter = ManagementApiHarness.ManualLimiter(tokenLimit: 1, queueLimit: 0);
		using RateLimitLease drained = limiter.AttemptAcquire();
		using ManagementApiHarness harness = ManagementApiHarness.Create(new HarnessOptions { Limiter = limiter });
		harness.Handler.Respond(_ => Auth0Responses.NoContent());

		// Act
		Result result = await harness.Api.AssignRoleAsync(ApiCalls.UserId, ApiCalls.RoleId, Xunit.TestContext.Current.CancellationToken);

		// Assert
		result.Success.Should().BeFalse();
		result.ErrorCode.Should().Be(ResultErrorCode.RateLimited);
		result.Details.Should().Be("ManagementApi.RateLimited");
		result.Error.Should().Be(FewSeconds);
		harness.Handler.ManagementRequests.Should().BeEmpty();
	}

	[Fact]
	public async Task Call_BothAttemptsWaitTheFullQueueTimeout_ReturnsRateLimitedEvenIfTheSdksTimeoutFiresFirst()
	{
		// Arrange
		// Two 4 s waits plus the SDK's backoff come to about the SDK's 10 s timeout, so either the second limiter 429 or
		// the timeout ends the call, and both must end as RateLimited.
		using TokenBucketRateLimiter limiter = ManagementApiHarness.ManualLimiter(tokenLimit: 1);
		using RateLimitLease drained = limiter.AttemptAcquire();
		using ManagementApiHarness harness = ManagementApiHarness.Create(
			new HarnessOptions { Limiter = limiter, QueueTimeout = TimeSpan.FromSeconds(4) });
		harness.Handler.Respond(_ => Auth0Responses.NoContent());

		// Act
		Result result = await harness.Api.AssignRoleAsync(ApiCalls.UserId, ApiCalls.RoleId, Xunit.TestContext.Current.CancellationToken);

		// Assert
		result.Success.Should().BeFalse();
		result.ErrorCode.Should().Be(ResultErrorCode.RateLimited);
		result.Details.Should().Be("ManagementApi.RateLimited");
		harness.Handler.ManagementRequests.Should().BeEmpty();
	}

	[Fact]
	public async Task Call_TimesOutWithoutAnyRateLimit_StillThrows()
	{
		// Arrange
		using ManagementApiHarness harness = ManagementApiHarness.Create();
		harness.Handler.Responder = async (_, cancellationToken) =>
		{
			await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);

			return Auth0Responses.NoContent();
		};

		// Act
		Func<Task> act = () => harness.Api.ListRolesAsync(Xunit.TestContext.Current.CancellationToken);

		// Assert
		await act.Should().ThrowAsync<Exception>("an unmarked timeout is an outage, not a rate limit");
	}
}

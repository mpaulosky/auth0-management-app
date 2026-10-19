// ============================================
// Copyright (c) 2026. All rights reserved.
// File Name :     RateLimitedMessageTests.cs
// Company :       mpaulosky
// Author :        Teqslamer
// Solution Name : Auth0ManagementApp
// Project Name :  UI.Tests.Unit
// =============================================

using Domain.Abstractions;

namespace UI.Tests.Unit.ManagementApi;

public class RateLimitedMessageTests
{
	private const string Prefix = "Auth0 is rate limiting the app. Try again in ";

	/// <summary>
	///   Runs <c>ListRolesAsync</c> against a 429 whose <c>X-RateLimit-Reset</c> is one real second ahead (the SDK waits
	///   until then to retry), with the fake clock set <paramref name="secondsBeforeReset" /> before that reset.
	/// </summary>
	private static async Task<Result> RateLimitedWithFakeClockAsync(int secondsBeforeReset)
	{
		using ManagementApiHarness harness = ManagementApiHarness.Create();
		long reset = DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 1;
		harness.Time.SetUtcNow(DateTimeOffset.FromUnixTimeSeconds(reset - secondsBeforeReset));
		harness.Handler.Respond(_ => Auth0Responses.RateLimited(reset));

		return await harness.Api.ListRolesAsync(Xunit.TestContext.Current.CancellationToken);
	}

	[Theory]
	[InlineData(7)]
	[InlineData(42)]
	public async Task RateLimited_ResetHeaderAhead_SaysTheSecondsLeftAgainstTheTimeProvider(int secondsLeft)
	{
		// Arrange

		// Act
		Result result = await RateLimitedWithFakeClockAsync(secondsLeft);

		// Assert
		result.Details.Should().Be("ManagementApi.RateLimited");
		result.Error.Should().Be($"{Prefix}{secondsLeft} seconds.");
	}

	[Theory]
	[InlineData(0)]
	[InlineData(-30)]
	public async Task RateLimited_ResetHeaderNowOrPast_SaysAtLeastOneSecond(int secondsBeforeReset)
	{
		// Arrange

		// Act
		Result result = await RateLimitedWithFakeClockAsync(secondsBeforeReset);

		// Assert
		result.Details.Should().Be("ManagementApi.RateLimited");
		result.Error.Should().StartWith($"{Prefix}1 second");
	}

	[Fact]
	public async Task RateLimited_NoResetHeader_SaysInAFewSeconds()
	{
		// Arrange
		using ManagementApiHarness harness = ManagementApiHarness.Create();
		harness.Handler.Respond(_ => Auth0Responses.RateLimited(resetUnixSeconds: null));

		// Act
		Result result = await harness.Api.ListRolesAsync(Xunit.TestContext.Current.CancellationToken);

		// Assert
		result.Details.Should().Be("ManagementApi.RateLimited");
		result.Error.Should().Be($"{Prefix}a few seconds.");
	}
}

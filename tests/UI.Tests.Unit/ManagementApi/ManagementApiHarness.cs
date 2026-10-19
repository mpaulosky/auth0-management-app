// ============================================
// Copyright (c) 2026. All rights reserved.
// File Name :     ManagementApiHarness.cs
// Company :       mpaulosky
// Author :        Teqslamer
// Solution Name : Auth0ManagementApp
// Project Name :  UI.Tests.Unit
// =============================================

using System.Globalization;
using System.Threading.RateLimiting;

using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Testing;
using Microsoft.Extensions.Time.Testing;

using UI.ManagementApi;

namespace UI.Tests.Unit.ManagementApi;

/// <summary>
///   What a test changes about the registered Management API seam.
/// </summary>
internal sealed class HarnessOptions
{
	/// <summary>The requests per second the registered limiter refills at. High by default, so only limiter tests wait.</summary>
	public int PermitsPerSecond { get; init; } = 100;

	public int Burst { get; init; } = 100;

	public TimeSpan QueueTimeout { get; init; } = TimeSpan.FromSeconds(1);

	/// <summary>A limiter that replaces the registered one, built with <c>AutoReplenishment = false</c> to replenish by hand.</summary>
	public RateLimiter? Limiter { get; init; }

	/// <summary>Whether <c>AddManagementApi()</c> runs twice, as it does when both slices register it.</summary>
	public bool RegisterTwice { get; init; }
}

/// <summary>
///   <c>AddManagementApi()</c> over a stub <see cref="HttpMessageHandler" /> on the <c>"Auth0Management"</c> client, a
///   <see cref="FakeTimeProvider" /> and a fake logger, with placeholder <c>Auth0:Management:*</c> settings.
/// </summary>
internal sealed class ManagementApiHarness : IDisposable
{
	public const string ClientSecret = "stub-client-secret-7be2d1a9";

	private readonly ServiceProvider _provider;

	private ManagementApiHarness(ServiceProvider provider, StubAuth0Handler handler, FakeTimeProvider time)
	{
		_provider = provider;
		Handler = handler;
		Time = time;
		Logs = provider.GetRequiredService<FakeLogCollector>();
		Api = provider.GetRequiredService<IManagementApi>();
	}

	public StubAuth0Handler Handler { get; }

	public FakeTimeProvider Time { get; }

	public FakeLogCollector Logs { get; }

	public IManagementApi Api { get; }

	/// <summary>Every log line the seam wrote, with its exception, as one string for each record.</summary>
	public IReadOnlyList<string> LogText =>
		[.. Logs.GetSnapshot().Select(record => $"{record.Message}\n{record.Exception}")];

	public static Dictionary<string, string?> Settings(HarnessOptions options)
	{
		ArgumentNullException.ThrowIfNull(options);

		return new Dictionary<string, string?>
		{
			["Auth0:Management:Domain"] = "auth0.placeholder.invalid",
			["Auth0:Management:ClientId"] = "stub-client-id",
			["Auth0:Management:ClientSecret"] = ClientSecret,
			["Auth0:Management:PermitsPerSecond"] = options.PermitsPerSecond.ToString(CultureInfo.InvariantCulture),
			["Auth0:Management:Burst"] = options.Burst.ToString(CultureInfo.InvariantCulture),
			["Auth0:Management:QueueTimeout"] = options.QueueTimeout.ToString("c", CultureInfo.InvariantCulture),
		};
	}

	public static ManagementApiHarness Create(HarnessOptions? options = null)
	{
		options ??= new HarnessOptions();

		StubAuth0Handler handler = new();
		// The SDK waits until X-RateLimit-Reset on the real clock, so the fake clock only drives the seam's own maths.
		FakeTimeProvider time = new(new DateTimeOffset(2026, 10, 19, 12, 0, 0, TimeSpan.Zero));
		IConfiguration configuration = new ConfigurationBuilder().AddInMemoryCollection(Settings(options)).Build();

		ServiceCollection services = new();
		services.AddSingleton(configuration);
		services.AddLogging(builder =>
		{
			builder.SetMinimumLevel(LogLevel.Trace);
			builder.AddFakeLogging();
		});
		services.AddSingleton<TimeProvider>(time);
		services.AddManagementApi();

		if (options.RegisterTwice)
		{
			services.AddManagementApi();
		}

		services.AddHttpClient("Auth0Management").ConfigurePrimaryHttpMessageHandler(() => handler);

		if (options.Limiter is not null)
		{
			services.RemoveAll<RateLimiter>();
			services.AddSingleton(options.Limiter);
		}

		return new ManagementApiHarness(services.BuildServiceProvider(), handler, time);
	}

	/// <summary>
	///   A token bucket that refills only when a test calls <see cref="ReplenishAsync" />. Its period is one millisecond
	///   because <see cref="TokenBucketRateLimiter.TryReplenish" /> does nothing until a full period has passed.
	/// </summary>
	public static TokenBucketRateLimiter ManualLimiter(int tokenLimit, int queueLimit = 100)
	{
		return new TokenBucketRateLimiter(new TokenBucketRateLimiterOptions
		{
			TokenLimit = tokenLimit,
			TokensPerPeriod = tokenLimit,
			ReplenishmentPeriod = TimeSpan.FromMilliseconds(1),
			AutoReplenishment = false,
			QueueLimit = queueLimit,
			QueueProcessingOrder = QueueProcessingOrder.OldestFirst,
		});
	}

	/// <summary>
	///   Replenishes <paramref name="limiter" /> once by hand: retries <see cref="TokenBucketRateLimiter.TryReplenish" />
	///   until it has changed the bucket, so a call that lands inside the replenishment period isn't lost.
	/// </summary>
	public static async Task ReplenishAsync(TokenBucketRateLimiter limiter)
	{
		ArgumentNullException.ThrowIfNull(limiter);

		RateLimiterStatistics before = limiter.GetStatistics()!;

		await WaitUntilAsync(() =>
		{
			limiter.TryReplenish();
			RateLimiterStatistics after = limiter.GetStatistics()!;

			return after.CurrentQueuedCount < before.CurrentQueuedCount || after.CurrentAvailablePermits > before.CurrentAvailablePermits;
		}, "the bucket has been replenished");
	}

	/// <summary>
	///   Polls until <paramref name="condition" /> holds, or fails after ten seconds.
	/// </summary>
	public static async Task WaitUntilAsync(Func<bool> condition, string description)
	{
		ArgumentNullException.ThrowIfNull(condition);

		using CancellationTokenSource timeout = new(TimeSpan.FromSeconds(10));

		while (!condition())
		{
			try
			{
				await Task.Delay(10, timeout.Token);
			}
			catch (OperationCanceledException)
			{
				throw new TimeoutException($"Timed out waiting until {description}.");
			}
		}
	}

	public void Dispose()
	{
		_provider.Dispose();
	}
}

// ============================================
// Copyright (c) 2026. All rights reserved.
// File Name :     ManagementApiRegistrationTests.cs
// Company :       mpaulosky
// Author :        Teqslamer
// Solution Name : Auth0ManagementApp
// Project Name :  UI.Tests.Unit
// =============================================

using System.Threading.RateLimiting;

using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Http;
using Microsoft.Extensions.Options;

using UI.ManagementApi;

namespace UI.Tests.Unit.ManagementApi;

public class ManagementApiRegistrationTests
{
	private static Dictionary<string, string?> ValidSettings() => ManagementApiHarness.Settings(new HarnessOptions());

	private static IHost BuildHost(Dictionary<string, string?> settings)
	{
		HostApplicationBuilder builder = Host.CreateEmptyApplicationBuilder(new HostApplicationBuilderSettings());
		builder.Configuration.AddInMemoryCollection(settings);
		builder.Services.AddLogging();
		builder.Services.AddManagementApi();

		return builder.Build();
	}

	[Fact]
	public void AddManagementApi_CalledTwice_RegistersEachServiceOnce()
	{
		// Arrange
		ServiceCollection services = new();
		services.AddManagementApi();
		int afterFirstCall = services.Count;

		// Act
		services.AddManagementApi();

		// Assert
		services.Count.Should().Be(afterFirstCall, "AddManagementApi() uses TryAdd*, so a second call adds nothing");
		services.Count(descriptor => descriptor.ServiceType == typeof(IManagementApi)).Should().Be(1);
		services.Count(descriptor => descriptor.ServiceType == typeof(RateLimiter) && descriptor.ServiceKey is "Auth0Management")
			.Should().Be(1);
		services.Should().NotContain(descriptor => descriptor.ServiceType == typeof(RateLimiter) && descriptor.ServiceKey == null,
			"the bucket is keyed, so it can't be resolved or displaced as a bare RateLimiter");
	}

	[Fact]
	public void AddManagementApi_Client_RecyclesItsPooledConnections()
	{
		// Arrange
		using IHost host = BuildHost(ValidSettings());
		HttpClientFactoryOptions options = host.Services.GetRequiredService<IOptionsMonitor<HttpClientFactoryOptions>>()
			.Get("Auth0Management");
		RecordingHandlerBuilder builder = new(host.Services) { Name = "Auth0Management" };

		// Act
		foreach (Action<HttpMessageHandlerBuilder> action in options.HttpMessageHandlerBuilderActions)
		{
			action(builder);
		}

		// Assert
		builder.PrimaryHandler.Should().BeOfType<SocketsHttpHandler>()
			.Which.PooledConnectionLifetime.Should().BeLessThanOrEqualTo(TimeSpan.FromMinutes(5),
				"the token provider's one long-lived client must still pick up a changed DNS record");
	}

	[Fact]
	public async Task AddManagementApi_CalledTwice_TakesOneTokenForEachRequest()
	{
		// Arrange
		using TokenBucketRateLimiter limiter = ManagementApiHarness.ManualLimiter(tokenLimit: 5);
		using ManagementApiHarness harness = ManagementApiHarness.Create(new HarnessOptions { Limiter = limiter, RegisterTwice = true });
		harness.Handler.Respond(_ => Auth0Responses.NoContent());

		// Act
		await harness.Api.AssignRoleAsync(ApiCalls.UserId, ApiCalls.RoleId, Xunit.TestContext.Current.CancellationToken);

		// Assert
		harness.Handler.ManagementRequests.Should().HaveCount(1);
		limiter.GetStatistics()!.CurrentAvailablePermits.Should().Be(4,
			"a second AddManagementApi() must not stack a second rate-limiting handler on the client");
	}

	[Fact]
	public async Task StartAsync_ValidSettings_StartsTheHost()
	{
		// Arrange
		using IHost host = BuildHost(ValidSettings());

		// Act
		Func<Task> start = () => host.StartAsync(Xunit.TestContext.Current.CancellationToken);

		// Assert
		await start.Should().NotThrowAsync();
	}

	[Theory]
	[InlineData("Auth0:Management:Domain")]
	[InlineData("Auth0:Management:ClientId")]
	[InlineData("Auth0:Management:ClientSecret")]
	public async Task StartAsync_RequiredSettingMissing_StopsTheHostFromStarting(string setting)
	{
		// Arrange
		Dictionary<string, string?> settings = ValidSettings();
		settings.Remove(setting);
		using IHost host = BuildHost(settings);

		// Act
		Func<Task> start = () => host.StartAsync(Xunit.TestContext.Current.CancellationToken);

		// Assert
		await start.Should().ThrowAsync<OptionsValidationException>();
	}

	[Fact]
	public async Task StartAsync_DomainWithScheme_StopsTheHostFromStarting()
	{
		// Arrange
		Dictionary<string, string?> settings = ValidSettings();
		settings["Auth0:Management:Domain"] = "https://tenant.us.auth0.com";
		using IHost host = BuildHost(settings);

		// Act
		Func<Task> start = () => host.StartAsync(Xunit.TestContext.Current.CancellationToken);

		// Assert
		await start.Should().ThrowAsync<OptionsValidationException>();
	}

	[Theory]
	[InlineData("Auth0:Management:PermitsPerSecond", "0")]
	[InlineData("Auth0:Management:PermitsPerSecond", "101")]
	[InlineData("Auth0:Management:Burst", "0")]
	[InlineData("Auth0:Management:Burst", "101")]
	[InlineData("Auth0:Management:QueueTimeout", "00:00:00")]
	[InlineData("Auth0:Management:QueueTimeout", "00:00:00.500")]
	[InlineData("Auth0:Management:QueueTimeout", "00:00:05")]
	public async Task StartAsync_SettingOutOfRange_FailsValidation(string setting, string value)
	{
		// Arrange
		Dictionary<string, string?> settings = ValidSettings();
		settings[setting] = value;
		using IHost host = BuildHost(settings);

		// Act
		Func<Task> start = () => host.StartAsync(Xunit.TestContext.Current.CancellationToken);

		// Assert
		await start.Should().ThrowAsync<OptionsValidationException>();
	}

	[Theory]
	[InlineData("Auth0:Management:PermitsPerSecond", "1")]
	[InlineData("Auth0:Management:PermitsPerSecond", "100")]
	[InlineData("Auth0:Management:Burst", "1")]
	[InlineData("Auth0:Management:Burst", "100")]
	[InlineData("Auth0:Management:QueueTimeout", "00:00:01")]
	[InlineData("Auth0:Management:QueueTimeout", "00:00:04")]
	public async Task StartAsync_SettingAtTheEdgeOfItsRange_Starts(string setting, string value)
	{
		// Arrange
		Dictionary<string, string?> settings = ValidSettings();
		settings[setting] = value;
		using IHost host = BuildHost(settings);

		// Act
		Func<Task> start = () => host.StartAsync(Xunit.TestContext.Current.CancellationToken);

		// Assert
		await start.Should().NotThrowAsync();
	}

	[Fact]
	public async Task StartAsync_OnlyTheRequiredSettings_UsesTheFreeTierBurstOfTwo()
	{
		// Arrange
		Dictionary<string, string?> settings = ValidSettings();
		settings.Remove("Auth0:Management:PermitsPerSecond");
		settings.Remove("Auth0:Management:Burst");
		settings.Remove("Auth0:Management:QueueTimeout");
		using IHost host = BuildHost(settings);

		// Act
		await host.StartAsync(Xunit.TestContext.Current.CancellationToken);
		RateLimiter limiter = host.Services.GetRequiredKeyedService<RateLimiter>("Auth0Management");

		// Assert
		limiter.GetStatistics()!.CurrentAvailablePermits.Should().Be(2, "Burst defaults to 2, the Free tier's bucket");
	}

	[Fact]
	public async Task StartAsync_BurstSet_SizesTheBucketFromIt()
	{
		// Arrange
		Dictionary<string, string?> settings = ValidSettings();
		settings["Auth0:Management:Burst"] = "7";
		using IHost host = BuildHost(settings);

		// Act
		await host.StartAsync(Xunit.TestContext.Current.CancellationToken);
		RateLimiter limiter = host.Services.GetRequiredKeyedService<RateLimiter>("Auth0Management");

		// Assert
		limiter.GetStatistics()!.CurrentAvailablePermits.Should().Be(7);
	}

	[Fact]
	public async Task StartAsync_SettingsSet_ResolvesIManagementApiOnce()
	{
		// Arrange
		using IHost host = BuildHost(ValidSettings());
		await host.StartAsync(Xunit.TestContext.Current.CancellationToken);

		// Act
		IReadOnlyList<IManagementApi> resolved = [.. host.Services.GetServices<IManagementApi>()];

		// Assert
		resolved.Should().HaveCount(1);
	}

	private sealed class RecordingHandlerBuilder(IServiceProvider services) : HttpMessageHandlerBuilder
	{
		public override string? Name { get; set; }

		public override HttpMessageHandler PrimaryHandler { get; set; } = new HttpClientHandler();

		public override IList<DelegatingHandler> AdditionalHandlers { get; } = [];

		public override IServiceProvider Services { get; } = services;

		public override HttpMessageHandler Build()
		{
			return PrimaryHandler;
		}
	}
}

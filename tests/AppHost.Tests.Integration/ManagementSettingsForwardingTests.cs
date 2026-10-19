// ============================================
// Copyright (c) 2026. All rights reserved.
// File Name :     ManagementSettingsForwardingTests.cs
// Company :       mpaulosky
// Author :        Teqslamer
// Solution Name : Auth0ManagementApp
// Project Name :  AppHost.Tests.Integration
// =============================================

using Aspire.Hosting;
using Aspire.Hosting.ApplicationModel;
using Aspire.Hosting.Testing;

using Domain.Constants;

using Microsoft.Extensions.DependencyInjection;

namespace AppHost.Tests.Integration;

// The Users slice registers the Management API seam, which validates Auth0:Management:* on start. WebApp only starts
// under the AppHost when those settings reach it, as the sign-in application's Auth0__* settings do.
public class ManagementSettingsForwardingTests
{
	[Fact]
	public async Task WebApp_ManagementSettingsConfigured_ReceivesTheDomainClientIdAndClientSecret()
	{
		// Arrange
		await using IDistributedApplicationTestingBuilder builder = await DistributedApplicationTestingBuilder
			.CreateAsync<global::Projects.AppHost>(TestContext.Current.CancellationToken);
		builder.Configuration["Auth0:Domain"] = "auth0.placeholder.invalid";
		builder.Configuration["Auth0:ClientId"] = "placeholder-client-id";
		builder.Configuration["Auth0:ClientSecret"] = "placeholder-client-secret";
		builder.Configuration["Auth0:Management:Domain"] = "management.placeholder.invalid";
		builder.Configuration["Auth0:Management:ClientId"] = "placeholder-management-client-id";
		builder.Configuration["Auth0:Management:ClientSecret"] = "placeholder-management-client-secret";

		// Act
		Dictionary<string, string> environment = await GetWebAppEnvironmentAsync(builder);

		// Assert
		environment.Should().Contain("Auth0__Management__Domain", "management.placeholder.invalid");
		environment.Should().Contain("Auth0__Management__ClientId", "placeholder-management-client-id");
		environment.Should().Contain("Auth0__Management__ClientSecret", "placeholder-management-client-secret");
	}

	[Fact]
	public async Task WebApp_ManagementSettingsConfigured_KeepsTheSignInApplicationsSettingsApart()
	{
		// Arrange
		await using IDistributedApplicationTestingBuilder builder = await DistributedApplicationTestingBuilder
			.CreateAsync<global::Projects.AppHost>(TestContext.Current.CancellationToken);
		builder.Configuration["Auth0:Domain"] = "auth0.placeholder.invalid";
		builder.Configuration["Auth0:ClientId"] = "placeholder-client-id";
		builder.Configuration["Auth0:ClientSecret"] = "placeholder-client-secret";
		builder.Configuration["Auth0:Management:Domain"] = "management.placeholder.invalid";
		builder.Configuration["Auth0:Management:ClientId"] = "placeholder-management-client-id";
		builder.Configuration["Auth0:Management:ClientSecret"] = "placeholder-management-client-secret";

		// Act
		Dictionary<string, string> environment = await GetWebAppEnvironmentAsync(builder);

		// Assert
		environment.Should().Contain("Auth0__ClientId", "placeholder-client-id");
		environment.Should().Contain("Auth0__ClientSecret", "placeholder-client-secret");
	}

	private static async Task<Dictionary<string, string>> GetWebAppEnvironmentAsync(
		IDistributedApplicationTestingBuilder builder)
	{
		CancellationToken cancellationToken = TestContext.Current.CancellationToken;

		// Building, without starting, gives the execution context the configuration builder resolves values with.
		await using DistributedApplication application = await builder.BuildAsync(cancellationToken);
		ProjectResource webApp = application.Services.GetRequiredService<DistributedApplicationModel>().Resources
			.OfType<ProjectResource>()
			.Single(resource => resource.Name == ApplicationConstants.Website);
		IExecutionConfigurationResult configuration = await ExecutionConfigurationBuilder.Create(webApp)
			.WithEnvironmentVariablesConfig()
			.BuildAsync(application.Services.GetRequiredService<DistributedApplicationExecutionContext>(),
				cancellationToken: cancellationToken);

		return configuration.EnvironmentVariables.ToDictionary(variable => variable.Key, variable => variable.Value);
	}
}

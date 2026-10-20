// ============================================
// Copyright (c) 2026. All rights reserved.
// File Name :     UsersPageTests.cs
// Company :       mpaulosky
// Author :        Teqslamer
// Solution Name : Auth0ManagementApp
// Project Name :  UI.Tests.Integration
// =============================================

using System.Net;

using Domain.Abstractions;

using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Primitives;

using UI.Components.Features.Authentication;
using UI.Components.Features.Users;
using UI.ManagementApi;
using UI.Tests.Integration.Fixtures;

namespace UI.Tests.Integration.Components.Features.Users;

public class UsersPageTests : IClassFixture<UiWebApplicationFactory>
{
	private const string UsersPath = "/admin/users";

	private readonly UiWebApplicationFactory _factory;
	private readonly IManagementApi _api = Substitute.For<IManagementApi>();

	public UsersPageTests(UiWebApplicationFactory factory)
	{
		ArgumentNullException.ThrowIfNull(factory);

		_factory = factory;
		_api.SearchUsersAsync(Arg.Any<UserSearch>(), Arg.Any<CancellationToken>()).Returns(Task.FromResult(Result.Ok(
			new UserPage([new UserSummary("auth0|1", "Jane Doe", "jane@example.com", null, null)], 1))));
		_api.ListRolesAsync(Arg.Any<CancellationToken>())
			.Returns(Task.FromResult(Result.Ok<IReadOnlyList<RoleSummary>>([new RoleSummary("role-admin", "Admin", null)])));
		_api.ListRoleMembersAsync(Arg.Any<string>(), Arg.Any<CancellationToken>())
			.Returns(Task.FromResult(Result.Ok(new RoleMembers([], false))));
	}

	[Fact]
	public async Task GetAdminUsers_Visitor_IsChallengedBackToAdminUsers()
	{
		// Arrange
		using HttpClient client = CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false });

		// Act
		HttpResponseMessage response =
			await client.GetAsync(new Uri(UsersPath, UriKind.Relative), TestContext.Current.CancellationToken);

		// Assert
		response.StatusCode.Should().Be(HttpStatusCode.Found);
		Uri? location = response.Headers.Location;
		location.Should().NotBeNull();
		string locationText = location!.OriginalString;
		locationText.Should().StartWith(AuthenticationEndpoints.LoginPath);
		Dictionary<string, StringValues> query =
			QueryHelpers.ParseQuery(locationText[locationText.IndexOf('?', StringComparison.Ordinal)..]);
		query["returnUrl"].ToString().Should().Be(UsersPath);
	}

	[Fact]
	public async Task GetAdminUsers_Visitor_CallsNoManagementApi()
	{
		// Arrange
		using HttpClient client = CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false });

		// Act
		await client.GetAsync(new Uri(UsersPath, UriKind.Relative), TestContext.Current.CancellationToken);

		// Assert
		_api.ReceivedCalls().Should().BeEmpty();
	}

	[Fact]
	public async Task GetAdminUsers_UserWithoutAdminRole_ReturnsForbiddenShowingAccessDeniedPage()
	{
		// Arrange
		using HttpClient client = CreateClient();
		client.DefaultRequestHeaders.Add(TestAuthHandler.UserHeaderName, "a-user");
		client.DefaultRequestHeaders.Add(TestAuthHandler.RoleClaimHeaderName, "User");

		// Act
		HttpResponseMessage response =
			await client.GetAsync(new Uri(UsersPath, UriKind.Relative), TestContext.Current.CancellationToken);
		string html = await response.Content.ReadAsStringAsync(TestContext.Current.CancellationToken);

		// Assert
		response.StatusCode.Should().Be(HttpStatusCode.Forbidden);
		html.Should().Contain("Access denied");
	}

	[Fact]
	public async Task GetAdminUsers_UserWithoutAdminRole_CallsNoManagementApi()
	{
		// Arrange
		using HttpClient client = CreateClient();
		client.DefaultRequestHeaders.Add(TestAuthHandler.UserHeaderName, "a-user");
		client.DefaultRequestHeaders.Add(TestAuthHandler.RoleClaimHeaderName, "User");

		// Act
		await client.GetAsync(new Uri(UsersPath, UriKind.Relative), TestContext.Current.CancellationToken);

		// Assert
		_api.ReceivedCalls().Should().BeEmpty();
	}

	[Fact]
	public async Task GetAdminUsers_Admin_ReturnsOkShowingTheSearchBox()
	{
		// Arrange
		using HttpClient client = CreateClient();
		client.DefaultRequestHeaders.Add(TestAuthHandler.UserHeaderName, "an-admin");
		client.DefaultRequestHeaders.Add(TestAuthHandler.RoleClaimHeaderName, "Admin");

		// Act
		HttpResponseMessage response =
			await client.GetAsync(new Uri(UsersPath, UriKind.Relative), TestContext.Current.CancellationToken);
		string html = await response.Content.ReadAsStringAsync(TestContext.Current.CancellationToken);

		// Assert
		response.StatusCode.Should().Be(HttpStatusCode.OK);
		html.Should().Contain("Search name or email");
	}

	[Fact]
	public void Services_Resolved_BuildTheUsersHandlerOverTheSubstitutedManagementApi()
	{
		// Arrange
		using WebApplicationFactory<Program> factory = WithSubstitutedManagementApi();

		// Act
		using IServiceScope scope = factory.Services.CreateScope();
		SearchUsersHandler handler = scope.ServiceProvider.GetRequiredService<SearchUsersHandler>();

		// Assert
		handler.Should().NotBeNull();
	}

	private HttpClient CreateClient(WebApplicationFactoryClientOptions? options = null) =>
		WithSubstitutedManagementApi().CreateClient(options ?? new WebApplicationFactoryClientOptions());

	private WebApplicationFactory<Program> WithSubstitutedManagementApi() =>
		_factory.WithWebHostBuilder(builder => builder.ConfigureTestServices(services =>
			services.AddSingleton(_api)));
}

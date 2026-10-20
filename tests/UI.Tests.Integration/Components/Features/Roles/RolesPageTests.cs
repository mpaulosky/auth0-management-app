// ============================================
// Copyright (c) 2026. All rights reserved.
// File Name :     RolesPageTests.cs
// Company :       mpaulosky
// Author :        Teqslamer
// Solution Name : Auth0ManagementApp
// Project Name :  UI.Tests.Integration
// =============================================

using System.Net;

using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Primitives;

using Domain.Abstractions;

using UI.Components.Features.Authentication;
using UI.Components.Features.Roles;
using UI.ManagementApi;
using UI.Tests.Integration.Fixtures;

namespace UI.Tests.Integration.Components.Features.Roles;

public class RolesPageTests : IClassFixture<UiWebApplicationFactory>
{
	private readonly IManagementApi _api = Substitute.For<IManagementApi>();
	private readonly UiWebApplicationFactory _factory;

	public RolesPageTests(UiWebApplicationFactory factory)
	{
		ArgumentNullException.ThrowIfNull(factory);

		_factory = factory;

		RoleSummary editor = new("rol_editor", "Editor", "Edits the content");
		UserSummary jane = new("auth0|jane", "Jane Doe", "jane@example.com", null, null);
		_api.ListRolesAsync(Arg.Any<CancellationToken>()).Returns(Result.Ok<IReadOnlyList<RoleSummary>>([editor]));
		_api.ListRoleMembersAsync(editor.Id, Arg.Any<CancellationToken>()).Returns(Result.Ok(new RoleMembers([jane], false)));
		_api.SearchUsersAsync(Arg.Any<UserSearch>(), Arg.Any<CancellationToken>())
			.Returns(Result.Ok(new UserPage([jane], 1)));
	}

	[Fact]
	public async Task GetRoles_Visitor_IsChallengedBackToRoles()
	{
		// Arrange
		await using WebApplicationFactory<Program> factory = WithManagementApi();
		using HttpClient client = factory.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false });

		// Act
		HttpResponseMessage response =
			await client.GetAsync(new Uri("/admin/roles", UriKind.Relative), TestContext.Current.CancellationToken);

		// Assert
		response.StatusCode.Should().Be(HttpStatusCode.Found);
		Uri? location = response.Headers.Location;
		location.Should().NotBeNull();
		string locationText = location!.OriginalString;
		locationText.Should().StartWith(AuthenticationEndpoints.LoginPath);
		Dictionary<string, StringValues> query =
			QueryHelpers.ParseQuery(locationText[locationText.IndexOf('?', StringComparison.Ordinal)..]);
		query["returnUrl"].ToString().Should().Be("/admin/roles");
		_api.ReceivedCalls().Should().BeEmpty("a Visitor causes no Management API call");
	}

	[Fact]
	public async Task GetRoles_UserWithoutAdminRole_ReturnsForbiddenShowingAccessDeniedPage()
	{
		// Arrange
		await using WebApplicationFactory<Program> factory = WithManagementApi();
		using HttpClient client = factory.CreateClient();
		client.DefaultRequestHeaders.Add(TestAuthHandler.UserHeaderName, "a-user");
		client.DefaultRequestHeaders.Add(TestAuthHandler.RoleClaimHeaderName, "User");

		// Act
		HttpResponseMessage response =
			await client.GetAsync(new Uri("/admin/roles", UriKind.Relative), TestContext.Current.CancellationToken);
		string html = await response.Content.ReadAsStringAsync(TestContext.Current.CancellationToken);

		// Assert
		response.StatusCode.Should().Be(HttpStatusCode.Forbidden);
		html.Should().Contain("Access denied");
		_api.ReceivedCalls().Should().BeEmpty("a User without Admin causes no Management API call");
	}

	[Fact]
	public async Task GetRoles_Admin_ReturnsOkShowingTheRolesAndTheirUsers()
	{
		// Arrange
		await using WebApplicationFactory<Program> factory = WithManagementApi();
		using HttpClient client = factory.CreateClient();
		client.DefaultRequestHeaders.Add(TestAuthHandler.UserHeaderName, "an-admin");
		client.DefaultRequestHeaders.Add(TestAuthHandler.RoleClaimHeaderName, "Admin");

		// Act
		HttpResponseMessage response =
			await client.GetAsync(new Uri("/admin/roles", UriKind.Relative), TestContext.Current.CancellationToken);
		string html = await response.Content.ReadAsStringAsync(TestContext.Current.CancellationToken);

		// Assert
		response.StatusCode.Should().Be(HttpStatusCode.OK);
		html.Should().Contain("Editor").And.Contain("Edits the content").And.Contain("Jane Doe");
	}

	private WebApplicationFactory<Program> WithManagementApi() => _factory.WithWebHostBuilder(builder =>
		builder.ConfigureTestServices(services =>
		{
			services.RemoveAll<IManagementApi>();
			services.AddSingleton(_api);
		}));
}

// ============================================
// Copyright (c) 2026. All rights reserved.
// File Name :     ManagementApiTests.cs
// Company :       mpaulosky
// Author :        Teqslamer
// Solution Name : Auth0ManagementApp
// Project Name :  Architecture.Tests
// =============================================

using System.Reflection;
using System.Runtime.CompilerServices;

using Architecture.Tests.Rules;

using UI.Components;
using UI.ManagementApi;

namespace Architecture.Tests;

public class ManagementApiTests
{
	private const string ManagementApiNamespace = "UI.ManagementApi";
	private const string FeaturesNamespace = "UI.Components.Features";
	private const string Auth0ManagementSdk = "Auth0.ManagementApi";

	[Fact]
	public void ManagementApi_Namespace_DependsOnNoFeatureSlice()
	{
		// Arrange
		Assembly uiAssembly = typeof(App).Assembly;

		// Act
		IReadOnlyList<string> featureDependencies =
			SharedDependencyRule.FindFeatureDependencies(uiAssembly, ManagementApiNamespace, FeaturesNamespace);
		IEnumerable<Type> managementApiTypes = Types.InAssembly(uiAssembly)
			.That()
			.ResideInNamespace(ManagementApiNamespace)
			.GetTypes();

		// Assert
		featureDependencies.Should().BeEmpty(
			"UI.ManagementApi holds cross-cutting code only, and never depends on a feature slice (ADR 0007, ADR 0009)");
		managementApiTypes.Should().NotBeEmpty(
			"IManagementApi is expected in UI.ManagementApi; an empty result would let a typo in the namespace above " +
			"pass this rule vacuously");
	}

	[Fact]
	public void UiAssembly_ManagementSdk_IsOnlyDependedOnByTheManagementApiNamespace()
	{
		// Arrange
		Assembly uiAssembly = typeof(App).Assembly;

		// Act
		NetArchTest.Rules.TestResult outsideResult = Types.InAssembly(uiAssembly)
			.That()
			.DoNotResideInNamespace(ManagementApiNamespace)
			.ShouldNot()
			.HaveDependencyOn(Auth0ManagementSdk)
			.GetResult();
		IEnumerable<Type> typesInsideUsingSdk = Types.InAssembly(uiAssembly)
			.That()
			.ResideInNamespace(ManagementApiNamespace)
			.And()
			.HaveDependencyOn(Auth0ManagementSdk)
			.GetTypes();

		// Assert
		(outsideResult.FailingTypeNames ?? []).Should()
			.BeEmpty("only UI.ManagementApi may reference the Auth0.ManagementApi SDK (ADR 0009)");
		typesInsideUsingSdk.Should().NotBeEmpty(
			"the adapter in UI.ManagementApi is expected to call into the SDK; an empty result would let a typo in " +
			"the namespace above pass that rule vacuously");
	}

	[Fact]
	public void ManagementApi_PublicTypes_ExposeNoSdkType()
	{
		// Arrange
		Assembly uiAssembly = typeof(App).Assembly;

		// Act
		IReadOnlyList<string> exposing =
			PublicApiExposureRule.FindTypesExposing(uiAssembly, ManagementApiNamespace, "Auth0");
		IReadOnlyList<string> publicTypes = PublicApiExposureRule.FindPublicTypes(uiAssembly, ManagementApiNamespace);

		// Assert
		exposing.Should().BeEmpty("the SDK's types stay behind IManagementApi, so a handler never touches one (ADR 0009)");
		publicTypes.Should().NotBeEmpty("an empty result would let a typo in the namespace above pass this rule vacuously");
	}

	[Fact]
	public void ManagementApi_Namespace_PublishesOnlyTheInterfaceItsRecordsProfileFieldAndTheRegistration()
	{
		// Arrange
		Assembly uiAssembly = typeof(App).Assembly;
		string[] expected =
		[
			typeof(IManagementApi).FullName!,
			typeof(UserSearch).FullName!,
			typeof(UserPage).FullName!,
			typeof(UserSummary).FullName!,
			typeof(UserDetails).FullName!,
			typeof(ProfileFieldsChange).FullName!,
			typeof(RoleSummary).FullName!,
			typeof(NewRole).FullName!,
			typeof(RoleMembers).FullName!,
			typeof(ProfileField).FullName!,
			typeof(ManagementApiServiceCollectionExtensions).FullName!,
		];

		// Act
		IReadOnlyList<string> publicTypes = PublicApiExposureRule.FindPublicTypes(uiAssembly, ManagementApiNamespace);

		// Assert
		publicTypes.Should().BeEquivalentTo(expected,
			"everything else in UI.ManagementApi (the adapter, token provider, options, rate limiter and its handler) is internal");
	}

	[Fact]
	public void ManagementApi_Interface_HasExactlyTheTenUseCaseMethods()
	{
		// Arrange
		string[] expected =
		[
			"SearchUsersAsync", "GetUserAsync", "UpdateProfileFieldsAsync", "AssignRoleAsync", "RemoveRoleAsync",
			"ListRolesAsync", "CreateRoleAsync", "ListRoleMembersAsync", "CountRoleMembersAsync", "UserHoldsRoleAsync",
		];

		// Act
		string[] methods = [.. typeof(IManagementApi).GetMethods().Select(method => method.Name)];

		// Assert
		methods.Should().BeEquivalentTo(expected);
	}

	[Fact]
	public void UiAssembly_InternalsVisibleTo_IsNeverDeclared()
	{
		// Arrange
		Assembly uiAssembly = typeof(App).Assembly;

		// Act
		IEnumerable<InternalsVisibleToAttribute> visibleTo = uiAssembly.GetCustomAttributes<InternalsVisibleToAttribute>();

		// Assert
		visibleTo.Should().BeEmpty("the ManagementApi tests go through AddManagementApi() and IManagementApi, not the internals");
	}
}
